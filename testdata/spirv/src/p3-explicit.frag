#version 450
layout(location=0) in vec2 inUV;
layout(location=0) out vec4 outColor;
layout(binding=1) uniform texture2D t;
layout(binding=2) uniform sampler s;
layout(binding=0) uniform UBO { mat4 mvp; float lod; } ubo;
void main() {
  outColor = textureLod(sampler2D(t, s), inUV, ubo.lod);
}
