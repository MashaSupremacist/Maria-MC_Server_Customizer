#include <new>

// Java 25's Android libjvm/libjli builds depend on libc++_shared.so, while the
// older Java 17 runtime does not. Keeping one small C++ translation unit in the
// launcher makes Gradle package the matching NDK shared C++ runtime for every
// APK ABI instead of relying on the downloaded JRE archive to provide it.
extern "C" void msc_require_shared_cpp_runtime() {
    auto *probe = new (std::nothrow) unsigned char;
    delete probe;
}
