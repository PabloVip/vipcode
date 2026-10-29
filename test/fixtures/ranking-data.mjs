// Datos inventados para las pruebas del ranking (los nombres son de modelos reales; las notas, no).
// vipcode no trae los datos de LLM Stats: cada usuario los descarga con su propia clave.
const model = (id, name, score, released = null) => ({ id, name, general: score, code: score, agents: score, tools: score, released });

export const RANKING_FIXTURE = {
  updated: "2026-10-01",
  source: "pruebas",
  models: [
    model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 60),
    model("glm-5.3", "GLM-5.3", 58),
    model("glm-5.3-flash", "GLM-5.3 Flash", 50),
    model("gemini-3.8-flash", "Gemini 3.8 Flash", 55, "2026-09-02"),
    model("gemini-3.7-flash", "Gemini 3.7 Flash", 52, "2026-06-10"),
    model("gemini-3.5-flash", "Gemini 3.5 Flash", 48, "2026-03-01"),
    model("gemini-3.8-flash-lite", "Gemini 3.8 Flash-Lite", 40, "2026-09-02"),
    model("qwen3.8-27b", "Qwen3.8 27B", 45),
    model("nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 42),
    model("beam-1.0-501b-a23b", "Beam 1.0", 54),
    model("llama-3.3-70b-instruct", "Llama 3.3 70B Instruct", 25),
    model("llama-4-scout", "Llama 4 Scout", 22),
    model("llama-4-maverick", "Llama 4 Maverick", 28),
    model("nova-2-pro", "Nova 2 Pro", 35),
    model("gpt-oss-120b", "gpt-oss-120b", 30),
    model("gpt-oss-20b", "gpt-oss-20b", 20),
    model("mistral-small-3.2-24b-instruct", "Mistral Small 3.2", 18),
    model("codestral-22b", "Codestral 22B", 10),
  ],
};
