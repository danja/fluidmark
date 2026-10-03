# vst/cmake/test_rust_targets.cmake
#
# Run with `cmake -P`. Checks the Rust target choice for platforms this machine is not, since a wrong triple on macOS
# or Windows would otherwise be found by a CI run on a machine nobody here can reach.

include("${CMAKE_CURRENT_LIST_DIR}/RustTargets.cmake")

set(failures 0)
function(check name expected_triples expected_lib)
    fluidmark_rust_triples(got got_lib ${ARGN})
    if(NOT "${got}" STREQUAL "${expected_triples}" OR NOT "${got_lib}" STREQUAL "${expected_lib}")
        message("FAIL  ${name}: got '${got}' / '${got_lib}', wanted '${expected_triples}' / '${expected_lib}'")
        math(EXPR n "${failures} + 1")
        set(failures ${n} PARENT_SCOPE)
    else()
        message("  ok  ${name}")
    endif()
endfunction()

check("Linux builds for the host" "HOST" "libfluidmark_core.a" APPLE OFF SYSTEM Linux PROCESSOR x86_64 MSVC OFF)
check("macOS universal builds both" "x86_64-apple-darwin;aarch64-apple-darwin" "libfluidmark_core.a"
      APPLE ON SYSTEM Darwin PROCESSOR arm64 ARCHS "x86_64;arm64" MSVC OFF)
check("macOS arm64 only" "aarch64-apple-darwin" "libfluidmark_core.a" APPLE ON SYSTEM Darwin PROCESSOR arm64 ARCHS "arm64" MSVC OFF)
check("macOS with no architecture set uses the machine's" "aarch64-apple-darwin" "libfluidmark_core.a"
      APPLE ON SYSTEM Darwin PROCESSOR arm64 MSVC OFF)
check("macOS Intel with none set" "x86_64-apple-darwin" "libfluidmark_core.a" APPLE ON SYSTEM Darwin PROCESSOR x86_64 MSVC OFF)
check("Windows with MinGW" "x86_64-pc-windows-gnu" "libfluidmark_core.a" APPLE OFF SYSTEM Windows PROCESSOR x86_64 MSVC OFF)
check("Windows with MSVC" "x86_64-pc-windows-msvc" "fluidmark_core.lib" APPLE OFF SYSTEM Windows PROCESSOR AMD64 MSVC ON)

# Things that must be refused, not guessed at.
# Passed with commas, since a semicolon would be split into separate arguments on the way.
foreach(case "APPLE,ON,SYSTEM,Darwin,PROCESSOR,arm64,ARCHS,ppc,MSVC,OFF" "APPLE,OFF,SYSTEM,Windows,PROCESSOR,ARM64,MSVC,OFF")
    execute_process(
        COMMAND ${CMAKE_COMMAND} -DCASE=${case} -P "${CMAKE_CURRENT_LIST_DIR}/refuse_rust_targets.cmake"
        RESULT_VARIABLE rc OUTPUT_QUIET ERROR_QUIET)
    if(rc EQUAL 0)
        message("FAIL  an unsupported platform was not refused: ${case}")
        math(EXPR failures "${failures} + 1")
    else()
        message("  ok  refuses ${case}")
    endif()
endforeach()

if(failures GREATER 0)
    message(FATAL_ERROR "${failures} failure(s)")
endif()
message("rust target tests: passed")
