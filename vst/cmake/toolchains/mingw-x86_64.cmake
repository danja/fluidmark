# vst/cmake/toolchains/mingw-x86_64.cmake
#
# Cross-compile the plugin for 64-bit Windows from Linux with MinGW-w64, as downspout does (DPF's own reference Windows
# builds are MinGW on a Linux runner). The POSIX-threads variants are named explicitly: Ubuntu ships both thread models
# and the default, win32 threads, has a libstdc++ with no std::thread or std::mutex, which the engine uses.

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc-posix)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++-posix)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)
set(CMAKE_AR x86_64-w64-mingw32-ar)
set(CMAKE_RANLIB x86_64-w64-mingw32-ranlib)
set(CMAKE_STRIP x86_64-w64-mingw32-strip)

set(CMAKE_FIND_ROOT_PATH /usr/x86_64-w64-mingw32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# The plugin is a DLL that a host loads on a machine that has none of MinGW's runtime. A DLL that imports
# libgcc_s_seh-1.dll, libstdc++-6.dll or libwinpthread-1.dll fails to load there with no useful message, so the
# runtime is linked in. `vst/scripts/package.sh` checks the result and fails the build if any of them is imported.
set(FLUIDMARK_MINGW_STATIC "-static -static-libgcc -static-libstdc++ -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,--no-whole-archive")
set(CMAKE_SHARED_LINKER_FLAGS_INIT "${FLUIDMARK_MINGW_STATIC}")
set(CMAKE_MODULE_LINKER_FLAGS_INIT "${FLUIDMARK_MINGW_STATIC}")
set(CMAKE_EXE_LINKER_FLAGS_INIT "${FLUIDMARK_MINGW_STATIC}")
