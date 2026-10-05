/*
 *  Copyright (C) 2012-2025  The Boxedwine Team
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 */

// Host side of the 64-bit Vulkan bridge. The guest libvulkan.so.1
// (tools/rootfs64/libvk64) traps into the kernel via VK64_SYSCALL_NR;
// ksyscall64 forwards here. The host owns the Vulkan implementation: object
// tables, command recording, and the frame manifest that is handed to the
// browser page once per frame.
//
// This is the Vulkan analogue of source/opengl/gl64bridge.h, and it is the
// same shape as the existing 32-bit Vulkan bridge (source/vulkan/vulkancommon.cpp)
// except that this one owns the implementation instead of forwarding to a real
// driver — there is no Vulkan loader and no ICD in the guest.

#ifndef __VK64BRIDGE_H__
#define __VK64BRIDGE_H__

class CPU64;

// Entry point from ksyscall64. fnId = RDI, argsAddr = RSI (guest VA of a
// VK64Args). Returns the call's result (or 0 for void) to be placed in RAX.
U64 vk64Bridge(CPU64* cpu, U64 fnId, U64 argsAddr);

#endif // __VK64BRIDGE_H__