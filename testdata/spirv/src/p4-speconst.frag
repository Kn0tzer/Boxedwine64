#version 450
layout(location=0) in vec2 inUV;
layout(location=1) in float inScale;
layout(location=0) out vec4 outColor;
layout(binding=1) uniform sampler2D tex;
layout(constant_id=10) const float GAMMA = 2.2;
layout(constant_id=11) const int MODE = 0;
void main() {
  vec4 t = texture(tex, inUV) * inScale;
  if (MODE == 0) {
    outColor = vec4(pow(t.rgb, vec3(1.0 / GAMMA)), t.a);
  } else {
    outColor = t;
  }
}
