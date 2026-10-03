# vst/cmake/RustTargets.cmake
#
# Which Rust target(s) a build needs, and what the static library is called, as a function of the platform CMake is
# configuring for. Kept apart from the main file so that `cmake/test_rust_targets.cmake` can run it for platforms this
# machine is not, which is the only check the macOS and Windows choices get here.
#
#   fluidmark_rust_triples(<out-triples> <out-libname>
#       APPLE <bool> SYSTEM <name> PROCESSOR <proc> ARCHS <list> MSVC <bool>)
#
# `HOST` stands for "no --target", because an empty list element does not survive CMake.

function(fluidmark_rust_triples out_triples out_libname)
    cmake_parse_arguments(P "" "APPLE;SYSTEM;PROCESSOR;MSVC" "ARCHS" ${ARGN})
    set(triples "")
    set(libname "libfluidmark_core.a")
    if(P_APPLE)
        set(archs ${P_ARCHS})
        if(NOT archs)
            set(archs ${P_PROCESSOR})
        endif()
        foreach(arch IN LISTS archs)
            if(arch STREQUAL "x86_64")
                list(APPEND triples x86_64-apple-darwin)
            elseif(arch STREQUAL "arm64" OR arch STREQUAL "aarch64")
                list(APPEND triples aarch64-apple-darwin)
            else()
                message(FATAL_ERROR "no Rust target known for macOS architecture '${arch}'")
            endif()
        endforeach()
    elseif(P_SYSTEM STREQUAL "Windows")
        if(NOT P_PROCESSOR MATCHES "^(AMD64|x86_64|X86_64)$")
            message(FATAL_ERROR "no Rust target known for Windows on '${P_PROCESSOR}'")
        endif()
        if(P_MSVC)
            list(APPEND triples x86_64-pc-windows-msvc)
            set(libname "fluidmark_core.lib")
        else()
            list(APPEND triples x86_64-pc-windows-gnu)
        endif()
    else()
        list(APPEND triples HOST)
    endif()
    set(${out_triples} "${triples}" PARENT_SCOPE)
    set(${out_libname} "${libname}" PARENT_SCOPE)
endfunction()
