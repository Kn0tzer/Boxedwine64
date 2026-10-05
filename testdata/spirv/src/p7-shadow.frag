#version 450
layout(location=0) in vec4 inShadowCoord;
layout(location=0) out vec4 outColor;
layout(binding=1) uniform sampler2DShadow shadowMap;
void main() {
  vec3 proj = inShadowCoord.xyz / inShadowCoord.w;
  float s = texture(shadowMap, proj);
  outColor = vec4(vec3(s), 1.0);
}
