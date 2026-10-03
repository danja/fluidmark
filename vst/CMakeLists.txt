# vst/CMakeLists.txt
#
# The Mark plugin and its engine. Follows downspout's shape (docs/vst.md): a portable engine with no plugin
# framework in it, a thin DPF wrapper, a custom NanoVG UI, tests that run without a DAW.
#
# The Rust core is built here with cargo and linked as a static library, so the plugin and the page run the
# same code and nothing in this tree re-implements any of it.
#
#   cmake -S vst -B build/vst -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/vst
#   ctest --test-dir build/vst --output-on-failure
#
# DPF is found at FLUIDMARK_DPF_DIR, which defaults to downspout's copy so that it is not vendored twice.

cmake_minimum_required(VERSION 3.20)
project(fluidmark-vst VERSION 0.1.0 LANGUAGES C CXX)

include(CTest)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

option(FLUIDMARK_ENABLE_DPF "Build the DPF plugin wrapper" ON)
option(FLUIDMARK_BUILD_STANDALONE "Also build a JACK standalone, for looking at the UI without a DAW" OFF)
set(FLUIDMARK_DPF_DIR "$ENV{HOME}/github/downspout/third_party/DPF" CACHE PATH "Where DPF is")

# ---- The Rust core ---------------------------------------------------------------------------------------
#
# Built with cargo as a static library for whatever this build targets, and linked into the plugin. Only the static
# library is asked for (`cargo rustc --crate-type staticlib`): the crate also lists a cdylib for the browser and a
# plain library, and building those would need a linker for the target that a cross build does not have.
#
#   Linux, native      no --target; the host's library.
#   macOS              x86_64-apple-darwin and/or aarch64-apple-darwin, by CMAKE_OSX_ARCHITECTURES, joined with lipo
#                      when there are two, so a universal plugin links a universal core.
#   Windows (MinGW)    x86_64-pc-windows-gnu, the target the MinGW toolchain and Rust's gnu std agree on.
#   Windows (MSVC)     x86_64-pc-windows-msvc. Not exercised by CI; here so the choice is visible.
#
# `rustup target add` for the triples this picks has to have been done, and CI does it.

find_program(FLUIDMARK_CARGO cargo REQUIRED)
get_filename_component(FLUIDMARK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(FLUIDMARK_RUST_DIR "${CMAKE_BINARY_DIR}/rust")
file(GLOB_RECURSE FLUIDMARK_RUST_SOURCES CONFIGURE_DEPENDS "${FLUIDMARK_ROOT}/wasm/src/*.rs")

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/RustTargets.cmake")
fluidmark_rust_triples(FLUIDMARK_RUST_TRIPLES FLUIDMARK_RUST_LIB_NAME
    APPLE "${APPLE}" SYSTEM "${CMAKE_SYSTEM_NAME}" PROCESSOR "${CMAKE_SYSTEM_PROCESSOR}"
    ARCHS "${CMAKE_OSX_ARCHITECTURES}" MSVC "${MSVC}")

set(_cargo_env "CARGO_TARGET_DIR=${FLUIDMARK_RUST_DIR}")
if(APPLE AND CMAKE_OSX_DEPLOYMENT_TARGET)
    # rustc has to build for the same minimum system the C++ does, or the linker warns of mismatched objects.
    list(APPEND _cargo_env "MACOSX_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET}")
endif()

set(_built_libs "")
foreach(_triple IN LISTS FLUIDMARK_RUST_TRIPLES)
    if(_triple STREQUAL "HOST")
        set(_lib "${FLUIDMARK_RUST_DIR}/release/${FLUIDMARK_RUST_LIB_NAME}")
        set(_target_args "")
    else()
        set(_lib "${FLUIDMARK_RUST_DIR}/${_triple}/release/${FLUIDMARK_RUST_LIB_NAME}")
        set(_target_args --target ${_triple})
    endif()
    add_custom_command(
        OUTPUT "${_lib}"
        COMMAND ${CMAKE_COMMAND} -E env ${_cargo_env}
                "${FLUIDMARK_CARGO}" rustc --release --lib --crate-type staticlib ${_target_args}
                --manifest-path "${FLUIDMARK_ROOT}/wasm/Cargo.toml"
        DEPENDS ${FLUIDMARK_RUST_SOURCES} "${FLUIDMARK_ROOT}/wasm/Cargo.toml"
        COMMENT "cargo rustc --release (the fluidmark core, ${_triple})"
        VERBATIM
    )
    list(APPEND _built_libs "${_lib}")
endforeach()

list(LENGTH _built_libs _built_count)
if(_built_count GREATER 1)
    find_program(FLUIDMARK_LIPO lipo REQUIRED)
    set(FLUIDMARK_CORE_LIB "${FLUIDMARK_RUST_DIR}/universal/${FLUIDMARK_RUST_LIB_NAME}")
    add_custom_command(
        OUTPUT "${FLUIDMARK_CORE_LIB}"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${FLUIDMARK_RUST_DIR}/universal"
        COMMAND "${FLUIDMARK_LIPO}" -create ${_built_libs} -output "${FLUIDMARK_CORE_LIB}"
        DEPENDS ${_built_libs}
        COMMENT "lipo: one universal core from ${_built_count} architectures"
        VERBATIM
    )
else()
    list(GET _built_libs 0 FLUIDMARK_CORE_LIB)
endif()
add_custom_target(fluidmark_core_build DEPENDS "${FLUIDMARK_CORE_LIB}")

add_library(fluidmark_core STATIC IMPORTED GLOBAL)
set_target_properties(fluidmark_core PROPERTIES IMPORTED_LOCATION "${FLUIDMARK_CORE_LIB}")
add_dependencies(fluidmark_core fluidmark_core_build)
find_package(Threads REQUIRED)
# What a Rust static library needs from the platform, from `rustc --print native-static-libs` for each target.
if(APPLE)
    target_link_libraries(fluidmark_core INTERFACE c m)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    target_link_libraries(fluidmark_core INTERFACE kernel32 ntdll userenv ws2_32 dbghelp)
else()
    target_link_libraries(fluidmark_core INTERFACE Threads::Threads ${CMAKE_DL_LIBS} m)
endif()

# What can run here. The engine and wrapper tests are host programs, so a cross build to Windows has nothing to run them
# on (no Wine in CI), and the allocation counter wraps malloc with GNU ld's --wrap, which only Linux has.
if(CMAKE_CROSSCOMPILING)
    set(FLUIDMARK_CAN_TEST OFF)
else()
    set(FLUIDMARK_CAN_TEST ON)
endif()

add_test(NAME rust_targets COMMAND ${CMAKE_COMMAND} -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/test_rust_targets.cmake")

# ---- The engine ------------------------------------------------------------------------------------------

add_library(fluidmark_mark_engine STATIC mark/src/mark_engine.cpp)
target_include_directories(fluidmark_mark_engine PUBLIC mark/include)
target_link_libraries(fluidmark_mark_engine PUBLIC fluidmark_core Threads::Threads)
target_compile_options(fluidmark_mark_engine PRIVATE -Wall -Wextra)

# ---- Tests: no DAW, no DPF -------------------------------------------------------------------------------

if(FLUIDMARK_CAN_TEST)
    add_executable(mark_engine_tests mark/tests/mark_engine_tests.cpp)
    target_link_libraries(mark_engine_tests PRIVATE fluidmark_mark_engine)
    target_compile_options(mark_engine_tests PRIVATE -Wall -Wextra)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        # Count every allocation, the Rust core's included, by wrapping the allocator at link time. A claim that the
        # audio thread allocates nothing is a count taken, and wrapping covers the static library as well as this code.
        target_compile_definitions(mark_engine_tests PRIVATE FLUIDMARK_WRAP_ALLOC=1)
        target_link_options(mark_engine_tests PRIVATE
            -Wl,--wrap=malloc -Wl,--wrap=calloc -Wl,--wrap=realloc -Wl,--wrap=posix_memalign -Wl,--wrap=aligned_alloc)
    endif()
    add_test(NAME mark_engine COMMAND mark_engine_tests)
endif()

# ---- The plugin ------------------------------------------------------------------------------------------

if(FLUIDMARK_ENABLE_DPF AND EXISTS "${FLUIDMARK_DPF_DIR}/CMakeLists.txt")
    set(DPF_EXAMPLES OFF CACHE BOOL "" FORCE)
    add_subdirectory("${FLUIDMARK_DPF_DIR}" third_party/DPF)

    set(FLUIDMARK_TARGETS vst3)
    if(FLUIDMARK_BUILD_STANDALONE)
        list(APPEND FLUIDMARK_TARGETS jack)
    endif()
    dpf_add_plugin(fluidmark_mark
        TARGETS ${FLUIDMARK_TARGETS}
        FILES_DSP mark/src/dpf/MarkPlugin.cpp
        FILES_UI mark/src/dpf/MarkUI.cpp
    )
    target_link_libraries(fluidmark_mark-dsp PUBLIC fluidmark_mark_engine)
    # The wrapper through DPF's own exporter, which every plugin format drives, so it runs without a host.
    # DPF's static target compiles the plugin and its framework into the program itself, which is what a test needs.
    if(FLUIDMARK_CAN_TEST)
    add_executable(mark_plugin_tests
        mark/tests/mark_plugin_tests.cpp
        mark/src/dpf/MarkPlugin.cpp
        "${FLUIDMARK_DPF_DIR}/distrho/DistrhoPluginMain.cpp")
    target_compile_definitions(mark_plugin_tests PRIVATE DISTRHO_PLUGIN_TARGET_STATIC)
    target_link_libraries(mark_plugin_tests PRIVATE fluidmark_mark_engine)
    target_include_directories(mark_plugin_tests PRIVATE
        "${FLUIDMARK_DPF_DIR}" "${FLUIDMARK_DPF_DIR}/distrho" "${FLUIDMARK_DPF_DIR}/distrho/src" mark/src/dpf)
    add_test(NAME mark_plugin COMMAND mark_plugin_tests)
    endif()

    target_include_directories(fluidmark_mark PUBLIC mark/include mark/src/dpf)
    target_include_directories(fluidmark_mark-ui PUBLIC mark/include mark/src/dpf)
else()
    message(STATUS "DPF not found at ${FLUIDMARK_DPF_DIR}: the plugin is not built, the engine and its tests are")
endif()
