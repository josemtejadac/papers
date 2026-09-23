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
