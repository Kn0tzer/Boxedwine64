#version 450
layout(location=0) in vec2 inUV;
layout(location=0) out vec4 outColor;
layout(binding=1) uniform sampler2D tex;
layout(push_constant) uniform PC { mat4 mvp; vec4 tint; float bias; } pc;
void main() {
  outColor = texture(tex, inUV, pc.bias) * pc.tint;
}
