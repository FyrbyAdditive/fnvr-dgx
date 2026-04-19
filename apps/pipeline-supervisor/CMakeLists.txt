cmake_minimum_required(VERSION 3.22)
project(fnvr_pipeline_supervisor CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GST REQUIRED
  gstreamer-1.0
  gstreamer-app-1.0
  gstreamer-video-1.0
  gstreamer-pbutils-1.0
  gstreamer-sdp-1.0
  gstreamer-webrtc-1.0
  glib-2.0
  gobject-2.0
)
pkg_check_modules(PQ REQUIRED libpq)

# nats.c — built from source or apt: libnats-dev. We probe pkg-config first,
# fall back to a header-only include path hint for source builds.
pkg_check_modules(NATS libnats QUIET)

add_executable(pipeline-supervisor
  src/main.cpp
  src/pipeline.cpp
  src/supervisor.cpp
  src/nats_publisher.cpp
  src/config.cpp
  src/db_reconciler.cpp
  src/rtsp_probe.cpp
  src/whep_server.cpp
)

# DeepStream headers + libs on Jetson live under /opt/nvidia/deepstream.
# Detect and link so the nvds metadata probe compiles in.
set(DEEPSTREAM_ROOT "/opt/nvidia/deepstream/deepstream" CACHE PATH "DeepStream install root")
if (EXISTS "${DEEPSTREAM_ROOT}/sources/includes/gstnvdsmeta.h")
  set(DEEPSTREAM_FOUND TRUE)
  message(STATUS "DeepStream: found at ${DEEPSTREAM_ROOT}")
else()
  set(DEEPSTREAM_FOUND FALSE)
  message(STATUS "DeepStream: NOT found — building fallback pipeline only")
endif()

target_include_directories(pipeline-supervisor PRIVATE
  ${GST_INCLUDE_DIRS}
  ${NATS_INCLUDE_DIRS}
  ${PQ_INCLUDE_DIRS}
  src
  $<$<BOOL:${DEEPSTREAM_FOUND}>:${DEEPSTREAM_ROOT}/sources/includes>
)

target_link_directories(pipeline-supervisor PRIVATE
  ${GST_LIBRARY_DIRS}
  ${NATS_LIBRARY_DIRS}
  ${PQ_LIBRARY_DIRS}
  $<$<BOOL:${DEEPSTREAM_FOUND}>:${DEEPSTREAM_ROOT}/lib>
)

target_link_libraries(pipeline-supervisor PRIVATE
  ${GST_LIBRARIES}
  ${NATS_LIBRARIES}
  ${PQ_LIBRARIES}
  # Fallback link if pkg-config didn't find libnats but -lnats is available.
  $<$<NOT:$<BOOL:${NATS_FOUND}>>:nats>
  $<$<BOOL:${DEEPSTREAM_FOUND}>:nvdsgst_meta>
  $<$<BOOL:${DEEPSTREAM_FOUND}>:nvds_meta>
  pthread
)

install(TARGETS pipeline-supervisor RUNTIME DESTINATION bin)
