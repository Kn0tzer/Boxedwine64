#version 450
layout(location=0) in vec3 inPos;
layout(location=0) out vec4 outShadowCoord;
layout(binding=0) uniform UBO { mat4 mvp; mat4 shadowMtx; } ubo;
void main() {
  gl_Position = ubo.mvp * vec4(inPos, 1.0);
  outShadowCoord = ubo.shadowMtx * vec4(inPos, 1.0);
}
