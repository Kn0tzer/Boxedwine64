#version 450
layout(location=0) in vec3 inPos;
layout(location=0) out vec2 outUV;
layout(push_constant) uniform PC { mat4 mvp; } pc;
void main() {
  gl_Position = pc.mvp * vec4(inPos, 1.0);
  outUV = inPos.xy;
}
