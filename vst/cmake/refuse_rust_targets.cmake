# vst/cmake/refuse_rust_targets.cmake: helper for test_rust_targets.cmake. Exits non-zero when the platform is refused.
include("${CMAKE_CURRENT_LIST_DIR}/RustTargets.cmake")
string(REPLACE "," ";" CASE "${CASE}")
fluidmark_rust_triples(t l ${CASE})
