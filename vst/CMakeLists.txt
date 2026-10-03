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

find_program(FLUIDMARK_CARGO cargo REQUIRED)
get_filename_component(FLUIDMARK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(FLUIDMARK_RUST_DIR "${CMAKE_BINARY_DIR}/rust")
set(FLUIDMARK_CORE_LIB "${FLUIDMARK_RUST_DIR}/release/libfluidmark_core.a")

file(GLOB_RECURSE FLUIDMARK_RUST_SOURCES CONFIGURE_DEPENDS "${FLUIDMARK_ROOT}/wasm/src/*.rs")
add_custom_command(
    OUTPUT "${FLUIDMARK_CORE_LIB}"
    COMMAND ${CMAKE_COMMAND} -E env "CARGO_TARGET_DIR=${FLUIDMARK_RUST_DIR}"
            "${FLUIDMARK_CARGO}" build --release --manifest-path "${FLUIDMARK_ROOT}/wasm/Cargo.toml"
    DEPENDS ${FLUIDMARK_RUST_SOURCES} "${FLUIDMARK_ROOT}/wasm/Cargo.toml"
    COMMENT "cargo build --release (the fluidmark core)"
    VERBATIM
)
add_custom_target(fluidmark_core_build DEPENDS "${FLUIDMARK_CORE_LIB}")

add_library(fluidmark_core STATIC IMPORTED GLOBAL)
set_target_properties(fluidmark_core PROPERTIES IMPORTED_LOCATION "${FLUIDMARK_CORE_LIB}")
add_dependencies(fluidmark_core fluidmark_core_build)
find_package(Threads REQUIRED)
# What a Rust static library needs from the platform.
target_link_libraries(fluidmark_core INTERFACE Threads::Threads ${CMAKE_DL_LIBS} m)

# ---- The engine ------------------------------------------------------------------------------------------

add_library(fluidmark_mark_engine STATIC mark/src/mark_engine.cpp)
target_include_directories(fluidmark_mark_engine PUBLIC mark/include)
target_link_libraries(fluidmark_mark_engine PUBLIC fluidmark_core Threads::Threads)
target_compile_options(fluidmark_mark_engine PRIVATE -Wall -Wextra)

# ---- Tests: no DAW, no DPF -------------------------------------------------------------------------------

add_executable(mark_engine_tests mark/tests/mark_engine_tests.cpp)
target_link_libraries(mark_engine_tests PRIVATE fluidmark_mark_engine)
target_compile_options(mark_engine_tests PRIVATE -Wall -Wextra)
# Count every allocation, the Rust core's included, by wrapping the allocator at link time. A claim that
# the audio thread allocates nothing is a count taken, and wrapping covers the static library as well as this code.
target_link_options(mark_engine_tests PRIVATE
    -Wl,--wrap=malloc -Wl,--wrap=calloc -Wl,--wrap=realloc -Wl,--wrap=posix_memalign -Wl,--wrap=aligned_alloc)
add_test(NAME mark_engine COMMAND mark_engine_tests)

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
    add_executable(mark_plugin_tests
        mark/tests/mark_plugin_tests.cpp
        mark/src/dpf/MarkPlugin.cpp
        "${FLUIDMARK_DPF_DIR}/distrho/DistrhoPluginMain.cpp")
    target_compile_definitions(mark_plugin_tests PRIVATE DISTRHO_PLUGIN_TARGET_STATIC)
    target_link_libraries(mark_plugin_tests PRIVATE fluidmark_mark_engine)
    target_include_directories(mark_plugin_tests PRIVATE
        "${FLUIDMARK_DPF_DIR}" "${FLUIDMARK_DPF_DIR}/distrho" "${FLUIDMARK_DPF_DIR}/distrho/src" mark/src/dpf)
    add_test(NAME mark_plugin COMMAND mark_plugin_tests)

    target_include_directories(fluidmark_mark PUBLIC mark/include mark/src/dpf)
    target_include_directories(fluidmark_mark-ui PUBLIC mark/include mark/src/dpf)
else()
    message(STATUS "DPF not found at ${FLUIDMARK_DPF_DIR}: the plugin is not built, the engine and its tests are")
endif()
