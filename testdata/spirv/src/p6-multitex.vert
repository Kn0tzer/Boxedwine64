#version 450
layout(location=0) in vec3 inPos;
layout(location=1) in vec2 inUV;
layout(location=0) out vec2 outUV0;
layout(location=1) out vec2 outUV1;
layout(binding=0) uniform UBO { mat4 mvp; } ubo;
void main() {
  gl_Position = ubo.mvp * vec4(inPos, 1.0);
  outUV0 = inUV;
  outUV1 = inUV * 2.0;
}
