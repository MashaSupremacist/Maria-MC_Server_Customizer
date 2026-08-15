#include <dlfcn.h>
#include <dirent.h>
#include <errno.h>
#include <elf.h>
#include <jni.h>
#include <fcntl.h>
#include <link.h>
#include <pthread.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef void *bytehook_stub_t;
typedef int (*bytehook_init_fn)(int mode, bool debug);
typedef bytehook_stub_t (*bytehook_hook_all_fn)(const char *callee_path_name, const char *sym_name,
                                                 void *new_func, void *hooked, void *hooked_arg);
typedef void (*bytehook_pop_stack_fn)(void *return_address);

static bytehook_pop_stack_fn bytehook_pop_stack_ptr;

typedef jint (*jli_launch_fn)(int argc, char **argv,
                              int jargc, const char **jargv,
                              int appclassc, const char **appclassv,
                              const char *fullversion, const char *dotversion,
                              const char *pname, const char *lname,
                              jboolean javaargs, jboolean cpwildcard,
                              jboolean javaw, jint ergo);
typedef jint (*jni_create_java_vm_fn)(JavaVM **vm, void **env, void *args);

static __thread sigjmp_buf *active_jump;

typedef struct {
    pthread_t thread;
    int input_write;
    int output_read;
    int saved_stdout;
    int saved_stderr;
    volatile int state;
    int pid;
    char *class_path;
    char *main_class;
    char *working_directory;
    char **arguments;
    int argument_count;
    char **libraries;
    int library_count;
} direct_process_t;

static pthread_mutex_t process_mutex = PTHREAD_MUTEX_INITIALIZER;
static direct_process_t *active_process;
static JavaVM *shared_vm;

static char *copy_jstring(JNIEnv *env, jstring value);
static void free_strings(char **values, int count);
static char **copy_string_array(JNIEnv *env, jobjectArray array, int *count_out);
static void *find_loaded_elf_symbol(const char *path, const char *symbol_name);

static void intercepted_exit(int code) {
    if (bytehook_pop_stack_ptr != NULL) bytehook_pop_stack_ptr(__builtin_return_address(0));
    if (active_jump != NULL) siglongjmp(*active_jump, code + 1);
    _exit(code);
}

static int install_exit_hook(void) {
    static int installed = 0;
    if (installed) return 1;
    void *bytehook = dlopen("libbytehook.so", RTLD_NOW | RTLD_GLOBAL);
    if (bytehook == NULL) return 0;
    bytehook_init_fn init = (bytehook_init_fn) dlsym(bytehook, "bytehook_init");
    bytehook_hook_all_fn hook_all = (bytehook_hook_all_fn) dlsym(bytehook, "bytehook_hook_all");
    bytehook_pop_stack_ptr = (bytehook_pop_stack_fn) dlsym(bytehook, "bytehook_pop_stack");
    if (init == NULL || hook_all == NULL || init(0, false) != 0) return 0;
    bytehook_stub_t stub = hook_all(NULL, "exit", (void *) intercepted_exit, NULL, NULL);
    installed = stub != NULL;
    return installed;
}

static void preload_runtime_libraries(char **libraries, int library_count) {
    // OpenJDK's Android launcher expects the VM and support libraries to be
    // resident before JLI_Launch; otherwise it may relaunch bin/java.  Keep
    // libnio out of this eager pass: its JNI registration must happen after
    // the VM is created, otherwise java.nio's UnixNativeDispatcher methods can
    // remain unresolved on Android even though libnio.so is present.
    const char *priority[] = {"libjvm.so", "libverify.so", "libjava.so", "libnet.so"};
    for (size_t p = 0; p < sizeof(priority) / sizeof(priority[0]); p++) {
        for (int i = 0; i < library_count; i++) {
            char path[1024];
            snprintf(path, sizeof(path), "%s/%s", libraries[i], priority[p]);
            void *handle = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
            if (handle != NULL) break;
        }
    }
    for (int i = 0; i < library_count; i++) {
        DIR *directory = opendir(libraries[i]);
        if (directory == NULL) continue;
        struct dirent *entry;
        while ((entry = readdir(directory)) != NULL) {
            const char *name = entry->d_name;
            size_t length = strlen(name);
            if (length <= 3 || strcmp(name + length - 3, ".so") != 0) continue;
            if (strcmp(name, "libnio.so") == 0) continue;
            char path[1024];
            snprintf(path, sizeof(path), "%s/%s", libraries[i], name);
            dlopen(path, RTLD_NOW | RTLD_GLOBAL);
        }
        closedir(directory);
    }
}

static char *copy_jstring(JNIEnv *env, jstring value) {
    if (value == NULL) return NULL;
    const char *utf = (*env)->GetStringUTFChars(env, value, NULL);
    if (utf == NULL) return NULL;
    char *copy = strdup(utf);
    (*env)->ReleaseStringUTFChars(env, value, utf);
    return copy;
}

static void free_strings(char **values, int count) {
    if (values == NULL) return;
    for (int i = 0; i < count; i++) free(values[i]);
    free(values);
}

static char **copy_string_array(JNIEnv *env, jobjectArray array, int *count_out) {
    int count = array == NULL ? 0 : (*env)->GetArrayLength(env, array);
    char **values = calloc((size_t) count + 1, sizeof(char *));
    if (values == NULL) return NULL;
    for (int i = 0; i < count; i++) {
        jstring item = (jstring) (*env)->GetObjectArrayElement(env, array, i);
        values[i] = copy_jstring(env, item);
        (*env)->DeleteLocalRef(env, item);
        if (values[i] == NULL) {
            free_strings(values, count);
            return NULL;
        }
    }
    *count_out = count;
    return values;
}

static char *read_pipe(int fd) {
    size_t capacity = 4096;
    size_t length = 0;
    char *result = malloc(capacity);
    if (result == NULL) return NULL;
    while (1) {
        if (length + 1024 + 1 > capacity) {
            capacity *= 2;
            char *expanded = realloc(result, capacity);
            if (expanded == NULL) {
                free(result);
                return NULL;
            }
            result = expanded;
        }
        ssize_t read_count = read(fd, result + length, 1024);
        if (read_count <= 0) break;
        length += (size_t) read_count;
    }
    result[length] = '\0';
    return result;
}

static char *find_library(char **libraries, int library_count, const char *name) {
    for (int i = 0; i < library_count; i++) {
        char path[1024];
        snprintf(path, sizeof(path), "%s/%s", libraries[i], name);
        if (access(path, R_OK) == 0) return strdup(path);
    }
    return NULL;
}

typedef struct {
    const char *path;
    uintptr_t base;
    const ElfW(Phdr) *program_headers;
    size_t program_header_count;
    int found;
    uintptr_t fallback_base;
    const ElfW(Phdr) *fallback_program_headers;
    size_t fallback_program_header_count;
} loaded_elf_t;

static int find_loaded_elf(struct dl_phdr_info *info, size_t size, void *opaque) {
    (void) size;
    loaded_elf_t *target = (loaded_elf_t *) opaque;
    if (info->dlpi_name == NULL || info->dlpi_name[0] == '\0') return 0;
    const char *target_name = strrchr(target->path, '/');
    const char *loaded_name = strrchr(info->dlpi_name, '/');
    target_name = target_name == NULL ? target->path : target_name + 1;
    loaded_name = loaded_name == NULL ? info->dlpi_name : loaded_name + 1;
    const int exact = strcmp(info->dlpi_name, target->path) == 0;
    if (!exact && strcmp(loaded_name, target_name) != 0) return 0;
    if (exact) {
        target->base = (uintptr_t) info->dlpi_addr;
        target->program_headers = info->dlpi_phdr;
        target->program_header_count = info->dlpi_phnum;
        target->found = 1;
        return 1;
    }
    if (target->fallback_program_headers == NULL) {
        target->fallback_base = (uintptr_t) info->dlpi_addr;
        target->fallback_program_headers = info->dlpi_phdr;
        target->fallback_program_header_count = info->dlpi_phnum;
    }
    return 0;
}

static void *find_loaded_elf_symbol(const char *path, const char *symbol_name) {
    loaded_elf_t object = {
        .path = path,
        .base = 0,
        .program_headers = NULL,
        .program_header_count = 0,
        .found = 0,
        .fallback_base = 0,
        .fallback_program_headers = NULL,
        .fallback_program_header_count = 0,
    };
    dl_iterate_phdr(find_loaded_elf, &object);
    if (!object.found && object.fallback_program_headers != NULL) {
        object.base = object.fallback_base;
        object.program_headers = object.fallback_program_headers;
        object.program_header_count = object.fallback_program_header_count;
        object.found = 1;
    }
    if (!object.found) return NULL;

    const ElfW(Dyn) *dynamic = NULL;
    for (size_t i = 0; i < object.program_header_count; i++) {
        if (object.program_headers[i].p_type == PT_DYNAMIC) {
            dynamic = (const ElfW(Dyn) *) (object.base + object.program_headers[i].p_vaddr);
            break;
        }
    }
    if (dynamic == NULL) return NULL;

    const ElfW(Sym) *symbols = NULL;
    const char *strings = NULL;
    const uint32_t *sysv_hash = NULL;
    const uint32_t *gnu_hash = NULL;
    for (const ElfW(Dyn) *entry = dynamic; entry->d_tag != DT_NULL; entry++) {
        switch (entry->d_tag) {
            case DT_SYMTAB:
                symbols = (const ElfW(Sym) *) (object.base + entry->d_un.d_ptr);
                break;
            case DT_STRTAB:
                strings = (const char *) (object.base + entry->d_un.d_ptr);
                break;
            case DT_HASH:
                sysv_hash = (const uint32_t *) (object.base + entry->d_un.d_ptr);
                break;
            case DT_GNU_HASH:
                gnu_hash = (const uint32_t *) (object.base + entry->d_un.d_ptr);
                break;
            default:
                break;
        }
    }
    if (symbols == NULL || strings == NULL) return NULL;

    size_t symbol_count = 0;
    if (sysv_hash != NULL) {
        symbol_count = sysv_hash[1];
    } else if (gnu_hash != NULL) {
        const uint32_t bucket_count = gnu_hash[0];
        const uint32_t symbol_offset = gnu_hash[1];
        const uint32_t bloom_count = gnu_hash[2];
        const size_t bloom_words = sizeof(ElfW(Addr)) / sizeof(uint32_t);
        const uint32_t *buckets = gnu_hash + 4 + ((size_t) bloom_count * bloom_words);
        const uint32_t *chains = buckets + bucket_count;
        uint32_t last_symbol = symbol_offset;
        for (uint32_t bucket = 0; bucket < bucket_count; bucket++) {
            if (buckets[bucket] > last_symbol) last_symbol = buckets[bucket];
        }
        if (last_symbol >= symbol_offset) {
            const uint32_t *chain = chains + (last_symbol - symbol_offset);
            while ((*chain & 1U) == 0U) {
                last_symbol++;
                chain++;
            }
            symbol_count = (size_t) last_symbol + 1U;
        }
    }
    if (symbol_count == 0) return NULL;

    for (size_t i = 0; i < symbol_count; i++) {
        const ElfW(Sym) *symbol = &symbols[i];
        if (symbol->st_name == 0 || strcmp(strings + symbol->st_name, symbol_name) != 0) continue;
        if (symbol->st_value == 0 || symbol->st_shndx == SHN_UNDEF) return NULL;
        uintptr_t address = (uintptr_t) symbol->st_value;
        if (symbol->st_shndx != SHN_ABS) address += object.base;
        return (void *) address;
    }
    return NULL;
}

static void *find_jni_create_java_vm(void *handle, const char *libjvm_path) {
    void *lookup_handle = handle == NULL ? RTLD_DEFAULT : handle;
    void *symbol = dlsym(lookup_handle, "JNI_CreateJavaVM");
    if (symbol != NULL) return symbol;

    // Some newer OpenJDK Android builds export the JNI entry points with the
    // ELF version `SUNWprivate_1.1`.  bionic's plain dlsym does not resolve a
    // versioned-only export, while dlvsym does.  Keep the unversioned lookup
    // above for the Java 17 package and probe the known OpenJDK version for
    // Java 21/25 and future builds.
#if defined(__ANDROID__) && __ANDROID_API__ >= 24
    const char *versions[] = {"SUNWprivate_1.1", "LIBJVM_1.0"};
    for (size_t i = 0; i < sizeof(versions) / sizeof(versions[0]); i++) {
        symbol = dlvsym(lookup_handle, "JNI_CreateJavaVM", versions[i]);
        if (symbol != NULL) return symbol;
    }
#endif
    // A few Android OpenJDK builds carry a valid version definition table that
    // bionic does not expose through dlvsym.  Resolve the exported dynamic
    // symbol directly from the already-loaded ELF image as a final fallback.
    return find_loaded_elf_symbol(libjvm_path, "JNI_CreateJavaVM");
}

static char *runtime_root_from_libjvm(const char *libjvm) {
    const char *suffixes[] = {"/lib/server/libjvm.so", "/lib/client/libjvm.so"};
    for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
        size_t path_length = strlen(libjvm);
        size_t suffix_length = strlen(suffixes[i]);
        if (path_length > suffix_length && strcmp(libjvm + path_length - suffix_length, suffixes[i]) == 0) {
            return strndup(libjvm, path_length - suffix_length);
        }
    }
    return NULL;
}

static void free_process(direct_process_t *process) {
    if (process == NULL) return;
    free(process->class_path);
    free(process->main_class);
    free(process->working_directory);
    free_strings(process->arguments, process->argument_count);
    free_strings(process->libraries, process->library_count);
    free(process);
}

static void *run_direct_process(void *opaque) {
    direct_process_t *process = (direct_process_t *) opaque;
    process->pid = (int) syscall(SYS_gettid);
    char previous_directory[2048];
    bool changed_directory = getcwd(previous_directory, sizeof(previous_directory)) != NULL &&
        chdir(process->working_directory) == 0;
    char *libjvm = find_library(process->libraries, process->library_count, "libjvm.so");
    char *runtime_root = libjvm == NULL ? NULL : runtime_root_from_libjvm(libjvm);
    if (libjvm == NULL || runtime_root == NULL) {
        fprintf(stdout, "PROCESS_ERROR: missing libjvm/runtime root\\n"); fflush(stdout);
        process->state = 4;
        if (changed_directory) chdir(previous_directory);
        free(runtime_root); free(libjvm);
        return NULL;
    }

    size_t library_path_length = 1;
    for (int i = 0; i < process->library_count; i++) library_path_length += strlen(process->libraries[i]) + 1;
    char *library_path = calloc(library_path_length, 1);
    if (library_path == NULL) {
        fprintf(stdout, "PROCESS_ERROR: could not allocate library path\\n"); fflush(stdout);
        process->state = 4;
        if (changed_directory) chdir(previous_directory);
        free(runtime_root); free(libjvm);
        return NULL;
    }
    for (int i = 0; i < process->library_count; i++) {
        if (i > 0) strcat(library_path, ":");
        strcat(library_path, process->libraries[i]);
    }
    setenv("LD_LIBRARY_PATH", library_path, 1);
    preload_runtime_libraries(process->libraries, process->library_count);
    JavaVM *vm = shared_vm;
    JNIEnv *vm_env = NULL;
    if (vm == NULL || (*vm)->AttachCurrentThread(vm, &vm_env, NULL) != JNI_OK || vm_env == NULL) {
        fprintf(stdout, "PROCESS_ERROR: no shared JNI VM available\\n"); fflush(stdout);
        process->state = 4;
        if (changed_directory) chdir(previous_directory);
        free(library_path); free(runtime_root); free(libjvm);
        return NULL;
    }

    // The embedded VM captures its initial user.dir when it is created by the
    // Android process (usually `/`).  Mojang's bundled server resolves its
    // extraction paths from that Java property, so update it for this server.
    jclass system_class = (*vm_env)->FindClass(vm_env, "java/lang/System");
    jmethodID set_property = system_class == NULL ? NULL :
        (*vm_env)->GetStaticMethodID(vm_env, system_class, "setProperty",
                                     "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    jstring user_dir_key = (*vm_env)->NewStringUTF(vm_env, "user.dir");
    jstring user_dir_value = (*vm_env)->NewStringUTF(vm_env, process->working_directory);
    if (set_property != NULL && user_dir_key != NULL && user_dir_value != NULL) {
        (*vm_env)->CallStaticObjectMethod(vm_env, system_class, set_property,
                                          user_dir_key, user_dir_value);
        if ((*vm_env)->ExceptionCheck(vm_env)) (*vm_env)->ExceptionClear(vm_env);
    }
    jstring bundler_dir_key = (*vm_env)->NewStringUTF(vm_env, "bundlerRepoDir");
    if (set_property != NULL && bundler_dir_key != NULL && user_dir_value != NULL) {
        (*vm_env)->CallStaticObjectMethod(vm_env, system_class, set_property,
                                          bundler_dir_key, user_dir_value);
        if ((*vm_env)->ExceptionCheck(vm_env)) (*vm_env)->ExceptionClear(vm_env);
    }
    jstring temp_dir_key = (*vm_env)->NewStringUTF(vm_env, "java.io.tmpdir");
    char temp_directory[2200];
    snprintf(temp_directory, sizeof(temp_directory), "%s/tmp", process->working_directory);
    jstring temp_dir_value = (*vm_env)->NewStringUTF(vm_env, temp_directory);
    if (set_property != NULL && temp_dir_key != NULL && temp_dir_value != NULL) {
        (*vm_env)->CallStaticObjectMethod(vm_env, system_class, set_property,
                                          temp_dir_key, temp_dir_value);
        if ((*vm_env)->ExceptionCheck(vm_env)) (*vm_env)->ExceptionClear(vm_env);
    }
    if (user_dir_key != NULL) (*vm_env)->DeleteLocalRef(vm_env, user_dir_key);
    if (user_dir_value != NULL) (*vm_env)->DeleteLocalRef(vm_env, user_dir_value);
    if (bundler_dir_key != NULL) (*vm_env)->DeleteLocalRef(vm_env, bundler_dir_key);
    if (temp_dir_key != NULL) (*vm_env)->DeleteLocalRef(vm_env, temp_dir_key);
    if (temp_dir_value != NULL) (*vm_env)->DeleteLocalRef(vm_env, temp_dir_value);
    if (system_class != NULL) (*vm_env)->DeleteLocalRef(vm_env, system_class);

    jclass main_class = (*vm_env)->FindClass(vm_env, process->main_class);
    jobject class_loader = NULL;
    jclass url_class = NULL;
    jclass url_loader_class = NULL;
    if (main_class == NULL) {
        (*vm_env)->ExceptionClear(vm_env);
        url_class = (*vm_env)->FindClass(vm_env, "java/net/URL");
        url_loader_class = (*vm_env)->FindClass(vm_env, "java/net/URLClassLoader");
        jclass url_array_class = (*vm_env)->FindClass(vm_env, "[Ljava/net/URL;");
        jmethodID url_constructor = url_class == NULL ? NULL :
            (*vm_env)->GetMethodID(vm_env, url_class, "<init>", "(Ljava/lang/String;)V");
        jmethodID loader_constructor = url_loader_class == NULL ? NULL :
            (*vm_env)->GetMethodID(vm_env, url_loader_class, "<init>", "([Ljava/net/URL;Ljava/lang/ClassLoader;)V");
        jmethodID load_class = url_loader_class == NULL ? NULL :
            (*vm_env)->GetMethodID(vm_env, url_loader_class, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;");
        char file_url[1600];
        snprintf(file_url, sizeof(file_url), "file:%s", process->class_path);
        jstring jar_path = (*vm_env)->NewStringUTF(vm_env, file_url);
        jobject url = (url_constructor == NULL || jar_path == NULL) ? NULL :
            (*vm_env)->NewObject(vm_env, url_class, url_constructor, jar_path);
        jobjectArray urls = (url_array_class == NULL || url == NULL) ? NULL :
            (*vm_env)->NewObjectArray(vm_env, 1, url_class, NULL);
        if (urls != NULL) (*vm_env)->SetObjectArrayElement(vm_env, urls, 0, url);
        class_loader = (loader_constructor == NULL || urls == NULL) ? NULL :
            (*vm_env)->NewObject(vm_env, url_loader_class, loader_constructor, urls, NULL);
        jstring class_name = (*vm_env)->NewStringUTF(vm_env, process->main_class);
        if (class_loader != NULL && load_class != NULL && class_name != NULL) {
            main_class = (jclass) (*vm_env)->CallObjectMethod(vm_env, class_loader, load_class, class_name);
        }
        if (class_name != NULL) (*vm_env)->DeleteLocalRef(vm_env, class_name);
        if (urls != NULL) (*vm_env)->DeleteLocalRef(vm_env, urls);
        if (url != NULL) (*vm_env)->DeleteLocalRef(vm_env, url);
        if (jar_path != NULL) (*vm_env)->DeleteLocalRef(vm_env, jar_path);
    }
    jmethodID main_method = main_class == NULL ? NULL :
        (*vm_env)->GetStaticMethodID(vm_env, main_class, "main", "([Ljava/lang/String;)V");
    jclass string_class = (*vm_env)->FindClass(vm_env, "java/lang/String");
    jobjectArray java_arguments = string_class == NULL ? NULL :
        (*vm_env)->NewObjectArray(vm_env, process->argument_count, string_class, NULL);
    for (int i = 0; java_arguments != NULL && i < process->argument_count; i++) {
        jstring value = (*vm_env)->NewStringUTF(vm_env, process->arguments[i]);
        (*vm_env)->SetObjectArrayElement(vm_env, java_arguments, i, value);
        (*vm_env)->DeleteLocalRef(vm_env, value);
    }
    if (main_class == NULL || main_method == NULL || java_arguments == NULL) {
        fprintf(stdout, "PROCESS_ERROR: probe main class could not be loaded\\n"); fflush(stdout);
        process->state = 4;
    } else {
        process->state = 1;
        (*vm_env)->CallStaticVoidMethod(vm_env, main_class, main_method, java_arguments);
        if (process->state != 3) process->state = (*vm_env)->ExceptionCheck(vm_env) ? 4 : 2;
        if ((*vm_env)->ExceptionCheck(vm_env)) (*vm_env)->ExceptionDescribe(vm_env);
    }
    if (java_arguments != NULL) (*vm_env)->DeleteLocalRef(vm_env, java_arguments);
    if (string_class != NULL) (*vm_env)->DeleteLocalRef(vm_env, string_class);
    if (main_class != NULL) (*vm_env)->DeleteLocalRef(vm_env, main_class);
    if (class_loader != NULL) (*vm_env)->DeleteLocalRef(vm_env, class_loader);
    if (url_class != NULL) (*vm_env)->DeleteLocalRef(vm_env, url_class);
    if (url_loader_class != NULL) (*vm_env)->DeleteLocalRef(vm_env, url_loader_class);
    (*vm)->DetachCurrentThread(vm);
    if (changed_directory) chdir(previous_directory);
    free(library_path); free(runtime_root); free(libjvm);
    return NULL;
}

JNIEXPORT jlong JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_startProcess(
        JNIEnv *env, jclass clazz, jstring class_path, jstring main_class,
        jstring working_directory, jobjectArray arguments, jobjectArray library_paths) {
    (void) clazz;
    pthread_mutex_lock(&process_mutex);
    if (active_process != NULL && (active_process->state == 0 || active_process->state == 1)) {
        pthread_mutex_unlock(&process_mutex);
        return 0;
    }
    if (active_process != NULL) {
        free_process(active_process);
        active_process = NULL;
    }
    direct_process_t *process = calloc(1, sizeof(direct_process_t));
    process->class_path = copy_jstring(env, class_path);
    process->main_class = copy_jstring(env, main_class);
    process->working_directory = copy_jstring(env, working_directory);
    process->arguments = copy_string_array(env, arguments, &process->argument_count);
    process->libraries = copy_string_array(env, library_paths, &process->library_count);
    if (process->class_path == NULL || process->main_class == NULL || process->working_directory == NULL || process->arguments == NULL || process->libraries == NULL) {
        free_process(process);
        pthread_mutex_unlock(&process_mutex);
        return 0;
    }
    int input_pipe[2];
    int output_pipe[2];
    if (pipe(input_pipe) != 0 || pipe(output_pipe) != 0) {
        free_process(process);
        pthread_mutex_unlock(&process_mutex);
        return 0;
    }
    process->input_write = input_pipe[1];
    process->output_read = output_pipe[0];
    process->saved_stdout = dup(STDOUT_FILENO);
    process->saved_stderr = dup(STDERR_FILENO);
    dup2(input_pipe[0], STDIN_FILENO);
    dup2(output_pipe[1], STDOUT_FILENO);
    dup2(output_pipe[1], STDERR_FILENO);
    close(input_pipe[0]); close(output_pipe[1]);
    int flags = fcntl(process->output_read, F_GETFL, 0);
    fcntl(process->output_read, F_SETFL, flags | O_NONBLOCK);
    active_process = process;
    process->state = 0;
    if (pthread_create(&process->thread, NULL, run_direct_process, process) != 0) {
        dup2(process->saved_stdout, STDOUT_FILENO); dup2(process->saved_stderr, STDERR_FILENO);
        close(process->saved_stdout); close(process->saved_stderr);
        close(process->input_write); close(process->output_read);
        active_process = NULL;
        free_process(process);
        pthread_mutex_unlock(&process_mutex);
        return 0;
    }
    pthread_mutex_unlock(&process_mutex);
    return (jlong) (intptr_t) process;
}

JNIEXPORT jstring JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_readProcessOutput(
        JNIEnv *env, jclass clazz, jlong handle) {
    (void) clazz;
    direct_process_t *process = (direct_process_t *) (intptr_t) handle;
    if (process == NULL) return (*env)->NewStringUTF(env, "");
    char buffer[4096];
    size_t total = 0;
    char *result = calloc(1, 1);
    ssize_t count;
    while ((count = read(process->output_read, buffer, sizeof(buffer))) > 0) {
        char *expanded = realloc(result, total + (size_t) count + 1);
        if (expanded == NULL) break;
        result = expanded;
        memcpy(result + total, buffer, (size_t) count);
        total += (size_t) count;
        result[total] = '\0';
    }
    jstring output = (*env)->NewStringUTF(env, result == NULL ? "" : result);
    free(result);
    return output;
}

JNIEXPORT jint JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_writeProcessInput(
        JNIEnv *env, jclass clazz, jlong handle, jstring input) {
    (void) clazz;
    direct_process_t *process = (direct_process_t *) (intptr_t) handle;
    char *value = copy_jstring(env, input);
    if (process == NULL || value == NULL) { free(value); return -1; }
    size_t length = strlen(value);
    ssize_t written = write(process->input_write, value, length);
    free(value);
    return written == (ssize_t) length ? 0 : -1;
}

JNIEXPORT jint JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_processState(
        JNIEnv *env, jclass clazz, jlong handle) {
    (void) env; (void) clazz;
    direct_process_t *process = (direct_process_t *) (intptr_t) handle;
    return process == NULL ? 4 : process->state;
}

JNIEXPORT jint JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_processPid(
        JNIEnv *env, jclass clazz, jlong handle) {
    (void) env; (void) clazz;
    direct_process_t *process = (direct_process_t *) (intptr_t) handle;
    return process == NULL ? -1 : process->pid;
}

JNIEXPORT void JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_stopProcess(
        JNIEnv *env, jclass clazz, jlong handle, jboolean force) {
    (void) env; (void) clazz;
    direct_process_t *process = (direct_process_t *) (intptr_t) handle;
    if (process == NULL) return;
    if (force && (process->state == 0 || process->state == 1)) {
        // Android's bionic libc does not expose pthread_cancel. Closing stdin
        // is the portable force-stop signal for the probe and causes a
        // blocked reader to exit immediately.
        close(process->input_write);
        process->input_write = -1;
        process->state = 3;
    } else if (!force && (process->state == 0 || process->state == 1)) {
        // The probe understands the native sentinel, while a Minecraft
        // server is a normal console and must receive the lowercase command.
        const char *stop = strstr(process->main_class, "MscServerLauncher") != NULL
            ? "stop\n" : "STOP\n";
        write(process->input_write, stop, strlen(stop));
    }
    if (process->state != 0 && process->state != 1) {
        pthread_join(process->thread, NULL);
        dup2(process->saved_stdout, STDOUT_FILENO); dup2(process->saved_stderr, STDERR_FILENO);
        close(process->saved_stdout); close(process->saved_stderr);
        close(process->input_write); close(process->output_read);
        pthread_mutex_lock(&process_mutex);
        if (active_process == process) active_process = NULL;
        pthread_mutex_unlock(&process_mutex);
    }
}

JNIEXPORT jstring JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_launchDirect(
        JNIEnv *env, jclass clazz, jobjectArray arguments, jobjectArray library_paths) {
    (void) clazz;
    int argument_count = 0;
    char **argv = copy_string_array(env, arguments, &argument_count);
    int library_count = 0;
    char **libraries = copy_string_array(env, library_paths, &library_count);
    if (argv == NULL || argument_count == 0 || libraries == NULL || library_count == 0) {
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nDirect JVM arguments were invalid");
    }

    size_t library_path_length = 1;
    for (int i = 0; i < library_count; i++) library_path_length += strlen(libraries[i]) + 1;
    char *library_path = calloc(library_path_length, 1);
    if (library_path == NULL) {
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nCould not allocate native library path");
    }
    for (int i = 0; i < library_count; i++) {
        if (i > 0) strcat(library_path, ":");
        strcat(library_path, libraries[i]);
    }
    setenv("LD_LIBRARY_PATH", library_path, 1);
    preload_runtime_libraries(libraries, library_count);

    char *libjvm = find_library(libraries, library_count, "libjvm.so");
    char *runtime_root = libjvm == NULL ? NULL : runtime_root_from_libjvm(libjvm);
    if (libjvm == NULL || runtime_root == NULL) {
        free(runtime_root);
        free(libjvm);
        free(library_path);
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nCould not locate libjvm.so or its runtime root");
    }

    void *handle = dlopen(libjvm, RTLD_NOW | RTLD_GLOBAL);
    if (handle == NULL) {
        const char *load_error = dlerror();
        char message[1400];
        snprintf(message, sizeof(message), "__MSC_EXIT__:-1\nCould not load libjvm.so: %s",
                 load_error == NULL ? "unknown dynamic linker error" : load_error);
        free(runtime_root); free(libjvm); free(library_path);
        free_strings(argv, argument_count); free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, message);
    }
    jni_create_java_vm_fn create_vm = (jni_create_java_vm_fn) find_jni_create_java_vm(handle, libjvm);
    if (shared_vm == NULL && create_vm == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "__MSC_EXIT__:-1\nlibjvm.so does not export JNI_CreateJavaVM: %s", dlerror());
        if (handle != NULL) dlclose(handle);
        free(runtime_root); free(libjvm); free(library_path);
        free_strings(argv, argument_count); free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, message);
    }

    char java_home_option[1024];
    char library_path_option[1200];
    char class_path_option[1200];
    snprintf(java_home_option, sizeof(java_home_option), "-Djava.home=%s", runtime_root);
    snprintf(library_path_option, sizeof(library_path_option), "-Djava.library.path=%s", library_path);
    snprintf(class_path_option, sizeof(class_path_option), "-Djava.class.path=%s/lib/*", runtime_root);
    JavaVMOption options[32] = {
        {java_home_option, NULL},
        {library_path_option, NULL},
        {class_path_option, NULL},
        {"-Xrs", NULL}
    };
    int option_count = 4;
    // launchDirect receives the selected server heap as ordinary launcher
    // arguments. Preserve only recognized VM heap flags for JNI_CreateJavaVM;
    // the remaining arguments are intentionally not forwarded to the VM.
    for (int i = 1; i < argument_count && option_count < 32; i++) {
        if (strncmp(argv[i], "-X", 2) == 0 || strncmp(argv[i], "-D", 2) == 0 ||
                strncmp(argv[i], "-XX:", 4) == 0 || strncmp(argv[i], "--add-", 6) == 0 ||
                strncmp(argv[i], "--module-", 9) == 0 || strncmp(argv[i], "--limit-", 8) == 0 ||
                strncmp(argv[i], "--patch-", 8) == 0 || strncmp(argv[i], "--upgrade-", 10) == 0 ||
                strncmp(argv[i], "--enable-", 9) == 0 || strncmp(argv[i], "-p", 2) == 0) {
            options[option_count++].optionString = argv[i];
        }
    }
    JavaVMInitArgs init_args;
    memset(&init_args, 0, sizeof(init_args));
    init_args.version = JNI_VERSION_1_6;
    init_args.nOptions = option_count;
    init_args.options = options;
    init_args.ignoreUnrecognized = JNI_FALSE;

    JavaVM *vm = shared_vm;
    JNIEnv *vm_env = NULL;
    jint create_result = JNI_OK;
    if (vm == NULL) {
        create_result = create_vm(&vm, (void **) &vm_env, &init_args);
        if (create_result == JNI_OK) shared_vm = vm;
    } else {
        create_result = (*vm)->AttachCurrentThread(vm, &vm_env, NULL);
    }
    if (create_result != JNI_OK || vm == NULL || vm_env == NULL) {
        char message[256];
        snprintf(message, sizeof(message), "__MSC_EXIT__:-1\nJNI_CreateJavaVM failed with code %d", create_result);
        if (handle != NULL) dlclose(handle);
        free(runtime_root); free(libjvm); free(library_path);
        free_strings(argv, argument_count); free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, message);
    }

    const char *version = NULL;
    jclass system_class = (*vm_env)->FindClass(vm_env, "java/lang/System");
    jmethodID get_property = system_class == NULL ? NULL :
        (*vm_env)->GetStaticMethodID(vm_env, system_class, "getProperty", "(Ljava/lang/String;)Ljava/lang/String;");
    jstring version_key = (*vm_env)->NewStringUTF(vm_env, "java.version");
    jstring version_value = (get_property == NULL || version_key == NULL) ? NULL :
        (jstring) (*vm_env)->CallStaticObjectMethod(vm_env, system_class, get_property, version_key);
    if (version_value != NULL) version = (*vm_env)->GetStringUTFChars(vm_env, version_value, NULL);
    char result[512];
    if (version == NULL) {
        snprintf(result, sizeof(result), "__MSC_EXIT__:-1\nJVM started but java.version could not be read");
    } else {
        snprintf(result, sizeof(result), "__MSC_EXIT__:0\nopenjdk version \"%s\"", version);
        (*vm_env)->ReleaseStringUTFChars(vm_env, version_value, version);
    }
    if (version_key != NULL) (*vm_env)->DeleteLocalRef(vm_env, version_key);
    if (version_value != NULL) (*vm_env)->DeleteLocalRef(vm_env, version_value);
    if (system_class != NULL) (*vm_env)->DeleteLocalRef(vm_env, system_class);
    // Keep the VM and its loaded runtime libraries alive for subsequent
    // managed process launches; Android permits only one invocation VM.
    free(runtime_root); free(libjvm); free(library_path);
    free_strings(argv, argument_count); free_strings(libraries, library_count);
    return (*env)->NewStringUTF(env, result);
}

JNIEXPORT jboolean JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_setWorkingDirectory(
        JNIEnv *env, jclass clazz, jstring directory) {
    (void) clazz;
    char *value = copy_jstring(env, directory);
    if (value == NULL) return JNI_FALSE;
    int result = chdir(value);
    free(value);
    return result == 0 ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_msc_minecraftservercustomizer_NativeJvmLauncher_launch(
        JNIEnv *env, jclass clazz, jstring libjli_path, jobjectArray arguments,
        jobjectArray library_paths, jstring full_version_value, jstring dot_version_value) {
    (void) clazz;
    char *libjli = copy_jstring(env, libjli_path);
    char *full_version = copy_jstring(env, full_version_value);
    char *dot_version = copy_jstring(env, dot_version_value);
    if (full_version == NULL) full_version = strdup("17.0.0-internal");
    if (dot_version == NULL) dot_version = strdup("17");
    int argument_count = 0;
    char **argv = copy_string_array(env, arguments, &argument_count);
    int library_count = 0;
    char **libraries = copy_string_array(env, library_paths, &library_count);
    if (libjli == NULL || full_version == NULL || dot_version == NULL || argv == NULL ||
            argument_count == 0 || libraries == NULL) {
        free(libjli);
        free(full_version);
        free(dot_version);
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nNative launcher arguments were invalid");
    }

    size_t library_path_length = 1;
    for (int i = 0; i < library_count; i++) library_path_length += strlen(libraries[i]) + 1;
    char *library_path = calloc(library_path_length, 1);
    if (library_path == NULL) {
        free(libjli);
        free(full_version);
        free(dot_version);
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nCould not allocate native library path");
    }
    for (int i = 0; i < library_count; i++) {
        if (i > 0) strcat(library_path, ":");
        strcat(library_path, libraries[i]);
    }
    setenv("LD_LIBRARY_PATH", library_path, 1);

    if (!install_exit_hook()) {
        free(library_path);
        free(libjli);
        free(full_version);
        free(dot_version);
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nCould not install the Android launcher exit hook");
    }

    void *handle = dlopen(libjli, RTLD_NOW | RTLD_GLOBAL);
    if (handle == NULL) {
        char message[1024];
        snprintf(message, sizeof(message), "__MSC_EXIT__:-1\nCould not load libjli.so: %s", dlerror());
        free(library_path);
        free(libjli);
        free(full_version);
        free(dot_version);
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, message);
    }
    jli_launch_fn launch = (jli_launch_fn) dlsym(handle, "JLI_Launch");
    if (launch == NULL) {
        dlclose(handle);
        free(library_path);
        free(libjli);
        free(full_version);
        free(dot_version);
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nlibjli.so does not export JLI_Launch");
    }
    preload_runtime_libraries(libraries, library_count);

    int output_pipe[2];
    if (pipe(output_pipe) != 0) {
        dlclose(handle);
        free(library_path);
        free(libjli);
        free(full_version);
        free(dot_version);
        free_strings(argv, argument_count);
        free_strings(libraries, library_count);
        return (*env)->NewStringUTF(env, "__MSC_EXIT__:-1\nCould not create launcher output pipe");
    }
    fflush(stdout);
    fflush(stderr);
    int old_stdout = dup(STDOUT_FILENO);
    int old_stderr = dup(STDERR_FILENO);
    dup2(output_pipe[1], STDOUT_FILENO);
    dup2(output_pipe[1], STDERR_FILENO);
    close(output_pipe[1]);

    jint exit_code;
    sigjmp_buf jump;
    int jump_result = sigsetjmp(jump, 1);
    if (jump_result == 0) {
        active_jump = &jump;
        exit_code = launch(argument_count, argv, 0, NULL, 0, NULL,
                            full_version, dot_version, argv[0], argv[0],
                            0, 1, 0, 0);
        active_jump = NULL;
    } else {
        active_jump = NULL;
        exit_code = jump_result - 1;
    }

    fflush(stdout);
    fflush(stderr);
    dup2(old_stdout, STDOUT_FILENO);
    dup2(old_stderr, STDERR_FILENO);
    close(old_stdout);
    close(old_stderr);
    char *output = read_pipe(output_pipe[0]);
    close(output_pipe[0]);
    if (output == NULL) output = strdup("Native launcher returned no output");

    size_t result_length = strlen(output) + 64;
    char *result = calloc(result_length, 1);
    if (result != NULL) snprintf(result, result_length, "__MSC_EXIT__:%d\n%s", exit_code, output);
    jstring java_result = (*env)->NewStringUTF(env, result == NULL ? "__MSC_EXIT__:-1\nCould not allocate launcher output" : result);

    free(result);
    free(output);
    dlclose(handle);
    free(library_path);
    free(libjli);
    free(full_version);
    free(dot_version);
    free_strings(argv, argument_count);
    free_strings(libraries, library_count);
    return java_result;
}
