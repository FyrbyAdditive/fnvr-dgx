cmake_minimum_required(VERSION 3.22)
project(fnvr_hailo_broker CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# HailoRT — required for this target. Unlike the pipeline-supervisor which
# builds the Hailo backend as an optional stub on dev machines, the broker
# is hailort-or-nothing.
if (NOT EXISTS "/usr/local/include/hailo/hailort.hpp")
  message(FATAL_ERROR "fnvr-hailo-broker requires HailoRT installed at /usr/local; build the image via deploy/docker/Dockerfile.hailo-broker or install hailort on the host first.")
endif()

add_executable(fnvr-hailo-broker
  src/main.cpp
  src/hailo_inference.cpp
)

target_compile_definitions(fnvr-hailo-broker PRIVATE FNVR_HAS_HAILO=1)

target_include_directories(fnvr-hailo-broker PRIVATE
  src
  /usr/local/include
)

target_link_directories(fnvr-hailo-broker PRIVATE
  /usr/local/lib
)

target_link_libraries(fnvr-hailo-broker PRIVATE
  hailort
  pthread
)

install(TARGETS fnvr-hailo-broker RUNTIME DESTINATION bin)
