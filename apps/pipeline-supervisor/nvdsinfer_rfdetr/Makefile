CUDA_VER ?= 13.2
CC := g++
CFLAGS := -Wall -std=c++14 -shared -fPIC \
  -I/opt/nvidia/deepstream/deepstream/sources/includes \
  -I/usr/local/cuda-$(CUDA_VER)/include
LIB := libnvdsinfer_custom_impl_rfdetr.so

all: $(LIB)

$(LIB): nvdsparse_rfdetr.cpp
	$(CC) -o $@ $< $(CFLAGS)

clean:
	rm -f $(LIB)
