# Activar el feed de Social compartido (Cloudflare D1)

Todo lo demás del prototipo sigue funcionando sin backend. Solo la pantalla **Social**
(publicaciones, me gusta, respuestas, citas) necesita esta base de datos para que todos los
visitantes vean el mismo feed. Si no haces estos pasos, esa pantalla mostrará un error de red al
intentar cargar — el resto de la app no se ve afectado.

## 1. Crear la base D1

En el dashboard de Cloudflare: **Workers & Pages → D1 → Create database**, nómbrala por ejemplo
`lab-papers-db`. (O con la CLI: `wrangler d1 create lab-papers-db`.)

## 2. Cargar el esquema y los datos iniciales

Con la CLI de Wrangler, desde esta misma carpeta:

```
wrangler d1 execute lab-papers-db --remote --file=./schema.sql
```

(`--remote` para que aplique sobre la base real en Cloudflare, no una simulada local.)

## 3. Conectar la base a tu proyecto de Pages

En el proyecto de Pages ya creado: **Settings → Functions → D1 database bindings → Add binding**.
- Variable name: `DB` (tiene que llamarse exactamente así, el código lo busca por ese nombre)
- D1 database: la que creaste en el paso 1

Guarda y vuelve a desplegar el proyecto para que el binding quede activo.

## ¿Qué pasa si no configuro esto?

La app sigue funcionando igual en Home, Biblioteca y Perfil. La pantalla Social intentará pedir
los datos a `/api/social/posts` y, si el binding `DB` no existe, la función devolverá un error;
el feed mostrará un aviso de "no se pudo cargar" en vez de romper el resto de la app.
