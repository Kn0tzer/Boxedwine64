#version 450
layout(location=0) in vec3 inNormal;
layout(location=1) in vec3 inWorldPos;
layout(location=0) out vec4 outColor;
layout(binding=1) uniform sampler2D albedoMap;
layout(binding=2) uniform UBO2 { vec3 lightDir; float intensity; } light;
void main() {
  vec3 n = normalize(inNormal);
  float d = max(dot(n, normalize(light.lightDir)), 0.0);
  vec3 albedo = texture(albedoMap, inWorldPos.xy).rgb;
  vec3 c = albedo * (0.1 + d * light.intensity);
  outColor = vec4(sqrt(c), 1.0);
}
