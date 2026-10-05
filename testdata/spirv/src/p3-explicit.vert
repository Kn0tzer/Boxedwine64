#version 450
layout(location=0) in vec3 inPos;
layout(location=0) out vec2 outUV;
layout(binding=0) uniform UBO { mat4 mvp; float lod; } ubo;
void main() {
  gl_Position = ubo.mvp * vec4(inPos, 1.0);
  outUV = inPos.xy + vec2(ubo.lod);
}
