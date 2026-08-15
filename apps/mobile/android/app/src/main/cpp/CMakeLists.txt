cmake_minimum_required(VERSION 3.22.1)
project(mscjvm LANGUAGES C CXX)

add_library(mscjvm SHARED msc_jvm_launcher.c msc_cpp_runtime.cpp)

find_library(log-lib log)
target_link_libraries(mscjvm ${log-lib} dl c++_shared)
