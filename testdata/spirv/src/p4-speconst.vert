#version 450
layout(location=0) in vec3 inPos;
layout(location=0) out vec2 outUV;
layout(location=1) out float outScale;
layout(constant_id=0) const float SCALE = 1.0;
layout(binding=0) uniform UBO { mat4 mvp; } ubo;
void main() {
  gl_Position = ubo.mvp * vec4(inPos * SCALE, 1.0);
  outUV = inPos.xy;
  outScale = SCALE;
}
