#version 450
layout(location=0) in vec2 inUV0;
layout(location=1) in vec2 inUV1;
layout(location=0) out vec4 outColor;
layout(binding=1) uniform sampler2D texA;
layout(binding=3) uniform texture2D texB;
layout(binding=4) uniform sampler sampB;
void main() {
  vec4 a = texture(texA, inUV0);
  vec2 dx = dFdx(inUV1);
  vec2 dy = dFdy(inUV1);
  vec4 b = textureGrad(sampler2D(texB, sampB), inUV1, dx, dy);
  outColor = a * b;
}
