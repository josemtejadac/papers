# Abstracta

Prototipo de app móvil para descubrir, guardar, leer y discutir papers científicos en comunidad.
Todo corre sobre Cloudflare: hosting en Pages, API en Pages Functions y base de datos en D1.

## Estructura
- `index.html` — interfaz completa (HTML/CSS/JS sin build)
- `functions/api/social/` — API del feed de Social (Pages Functions)
- `schema.sql` — esquema y datos iniciales de la base D1

## Despliegue en Cloudflare Pages (conectado a este repo)
1. Workers & Pages → Create → Pages → Connect to Git → repo `papers`, rama `main`.
2. Build command: vacío. Build output directory: `/` (raíz).
3. Crear una base D1 (`lab-papers-db`) y ejecutar `schema.sql` en su Console.
4. Settings → Functions → D1 database bindings: variable `DB` → `lab-papers-db` (en Production y Preview).
5. Re-desplegar.

Detalle en [SETUP-SOCIAL-DB.md](SETUP-SOCIAL-DB.md).

## Chat, perfiles y app instalable
- Cada persona elige su nombre y recibe un código único (`Nombre#1234`) para que la encuentren.
- Chats directos privados, sala pública para todos y feed público (todo en D1, sin Supabase).
- Tablas nuevas: pegar `migration-002.sql` en la Console de la base D1 (una sola vez).
- Es una PWA: se puede instalar desde el navegador (`manifest.webmanifest` + `sw.js`).

## Papers reales (arXiv)
- Home busca directamente en la API pública de arXiv (`functions/api/papers.js` +
  `functions/_lib/arxiv.js`). Funciona sin configuración extra.
- Si se agrega un binding de **Workers AI** (`AI`), los papers se traducen al idioma elegido en
  Perfil y se cachean en D1 (`paper_translations`, `migration-003.sql`). Sin ese binding, se ven
  en inglés tal cual los entrega arXiv — el resto de la app sigue igual.
- Detalle y costo en [SETUP-ARXIV-AI.md](SETUP-ARXIV-AI.md).
- Requiere mostrar la atribución de arXiv (ya está en Perfil): "Gracias a arXiv por el uso de su
  interoperabilidad de acceso abierto." Cada paper conserva su propia licencia elegida en arXiv.

## PDF sin conexión, biblioteca con buscador, editar/eliminar tus posts, filtros de búsqueda
- **PDF sin conexión real**: "Descargar" guarda el PDF en el dispositivo (vía `/api/pdf`, el mismo
  proxy que cachea el Service Worker), no solo abre un enlace externo.
- **Caché general**: todo paper que la app haya mostrado queda disponible sin conexión (hasta 300
  papers), no solo los guardados en una carpeta. Si se corta la red, Home muestra el último deck
  cargado en vez de un error.
- **Biblioteca**: ahora se puede buscar por título o autor dentro de lo guardado.
- **Social**: se puede editar o eliminar tu propia publicación (requiere `migration-004.sql`, que
  agrega `author_public_id`/`edited_at` a `posts` y la tabla `paper_summaries`).
- **Búsqueda en arXiv**: además de texto libre, se puede filtrar por categoría exacta y rango de
  fechas (botón "Filtros" junto al buscador de Home).
- **Resumen simple con IA**: el lector pide un resumen corto en lenguaje llano del paper, aparte
  del resumen oficial (mismo binding `AI` de la traducción).
