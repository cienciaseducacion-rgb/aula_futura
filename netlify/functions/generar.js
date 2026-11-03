const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const KEY = process.env.GEMINI_API_KEY;
const MAX_CHARS = 4 * 1024 * 1024;

const SYS = `Eres asistente de diseño de práctica docente universitaria. Trabajas solo con el contenido de los documentos, el contexto y los datos que recibes. No inventes asignaturas, unidades, objetivos, criterios, cifras ni nombres. Si falta un dato, indícalo en "nota_faltante". No incluyas nombres de estudiantes ni datos que permitan identificarlos. Responde únicamente con JSON válido en español, sin texto fuera del JSON.`;

const PREG = `Con los documentos adjuntos, redacta entre 5 y 8 preguntas que el docente debe poder responder sobre su práctica: resultados de aprendizaje, criterios de evaluación, actividades previstas y cómo sabrá si los estudiantes avanzan. Cada pregunta indica la unidad o sección del documento de la que surge. Formato: {"preguntas":[{"asignatura":"","fuente":"","pregunta":""}]}`;

const ESC = `Con los documentos, las respuestas del docente, la lista de asignaturas y el diagnóstico de necesidades, crea exactamente dos escenarios de aula por asignatura registrada.

Reglas:
- Cada escenario corresponde a una unidad o sección distinta del documento. No repitas la misma unidad ni la misma categoría en dos escenarios de la misma asignatura.
- El problema del escenario debe deducirse del documento o de las respuestas del docente. Si el docente respondió una pregunta relacionada, úsala para describir la situación.
- Las opciones deben ser realistas con el diagnóstico: si el tiempo es menor a 10 minutos, si no hay plataforma virtual o si hay más de 35 estudiantes, las decisiones deben poder aplicarse con esas condiciones.
- En "fuente" escribe la unidad o sección exacta del documento de la que sale el escenario.
- Si algún dato del escenario no está en el documento, escríbelo en "nota_faltante". Si todo está respaldado, déjalo vacío.

Campos de cada escenario: asignatura, fuente, nombre (máximo seis palabras), title, nivel (1 o 2), tag, context (máximo 90 palabras, sin datos de estudiantes), options (exactamente cuatro, cada una con t, q con tres preguntas socráticas que no indiquen cuál opción es correcta, y r con n, b y ej), ejemplo (retroalimentación formativa que no dé la solución), reflexion (tres preguntas) y nota_faltante.

ej puede ser {"tipo":"tabla","cab":[...],"filas":[[...]]}, {"tipo":"pasos","items":[...]} o {"tipo":"mensaje","texto":"..."}.

Formato: {"escenarios":[...]}`;

const DEC = `Con el contexto del escenario que describe el docente, propón exactamente cuatro decisiones didácticas distintas que el docente podría tomar ante ese caso. Cada decisión es una acción concreta, escrita en una sola frase en infinitivo, por ejemplo "Dividir el grupo en parejas para resolver un caso breve". Las cuatro deben ser distintas entre sí. No indiques cuál es la mejor, no las califiques, no des la solución y no incluyas nombres de estudiantes. Formato: {"opciones":["","","",""]}`;

const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido." });
  if (!KEY) return json(500, { error: "El servicio no está disponible en este momento." });
  if ((event.body || "").length > MAX_CHARS) return json(413, { error: "Los archivos superan el tamaño permitido." });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Solicitud no válida." }); }

  const { action, documentos = [], respuestas = [], asignaturas = [], contexto = "", diagnostico = null } = body;
  if (!["preguntas", "escenarios", "decisiones"].includes(action)) return json(400, { error: "Acción no válida." });

  const parts = [];

  if (action === "decisiones") {
    if (typeof contexto !== "string" || contexto.trim().length < 20) return json(400, { error: "Describe primero el contexto del escenario." });
    parts.push({ text: `Contexto del escenario:\n${contexto.slice(0, 3000)}` });
    parts.push({ text: DEC });
  } else {
    if (!Array.isArray(documentos) || documentos.length === 0 || documentos.length > 2) return json(400, { error: "Sube uno o dos documentos." });
    if (!Array.isArray(asignaturas) || asignaturas.length > 5) return json(400, { error: "Demasiadas asignaturas." });
    for (const d of documentos) {
      if (d.mime === "application/pdf" && typeof d.base64 === "string") {
        parts.push({ inline_data: { mime_type: "application/pdf", data: d.base64 } });
      } else if (typeof d.texto === "string") {
        parts.push({ text: `Documento "${String(d.nombre).slice(0, 80)}":\n${d.texto.slice(0, 60000)}` });
      }
    }
    const diag = diagnostico && typeof diagnostico === "object" ? JSON.stringify(diagnostico).slice(0, 1000) : "No disponible";
    parts.push({ text: `Asignaturas registradas: ${JSON.stringify(asignaturas)}\nRespuestas del docente: ${JSON.stringify(respuestas)}\nDiagnóstico de necesidades: ${diag}` });
    parts.push({ text: action === "preguntas" ? PREG : ESC });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
    });
    if (!res.ok) {
      console.error("Gemini respondió con error", res.status, (await res.text()).slice(0, 500));
      return json(502, { error: "El modelo no respondió. Intenta de nuevo en unos minutos." });
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return json(200, JSON.parse(text));
  } catch (e) {
    console.error("Error al generar", String(e).slice(0, 300));
    return json(502, { error: "No se pudo generar el contenido. Revisa el texto e intenta de nuevo." });
  } finally {
    clearTimeout(timer);
  }
};
