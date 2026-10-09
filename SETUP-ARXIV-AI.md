# Activar los papers reales de arXiv (y la traducción al español)

Desde este cambio, Home ya no muestra papers de ejemplo: busca directamente en la API pública de
arXiv (https://info.arxiv.org/help/api/index.html). Eso no necesita ninguna configuración — ya
funciona solo con el deploy normal del sitio.

Lo único opcional es la **traducción automática al español** (y a los otros idiomas de
Preferencias de idioma). Sin este paso, los papers se ven en inglés, tal cual los entrega arXiv;
el resto de la app sigue funcionando igual.

## Activar la traducción (Cloudflare Workers AI)

1. En el proyecto `papers` → **Settings → Bindings → Add**.
2. Elige **Workers AI**, con variable name `AI` (exacto, en mayúsculas).
3. Guarda y vuelve a desplegar (Deployments → ⋯ → Retry deployment).

No hay que crear nada más: Workers AI no es una base de datos aparte, es un binding que da acceso
al modelo de traducción (`@cf/meta/m2m100-1.2b`), gestionado por Cloudflare.

## Cargar la tabla de caché de traducciones

La primera vez que alguien abre un paper en un idioma, se traduce y se guarda en D1 para no
volver a traducirlo. Hace falta esta tabla extra en la base `lab-papers-db` (Console, igual que
`schema.sql` o `migration-002.sql`):

```sql
CREATE TABLE IF NOT EXISTS paper_translations (
  arxiv_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (arxiv_id, lang)
);
```

(Está en `migration-003.sql` del repo, por si prefieres copiarlo de ahí.)

## Costo

- **arXiv**: gratis, sin límite relevante para este uso.
- **Workers AI**: tiene una cuota gratis diaria en Cloudflare. Si se agota, las traducciones
  fallan silenciosamente y la app muestra el texto en inglés hasta el día siguiente — no se cae
  nada ni se cobra nada automáticamente, salvo que actives el plan pago.

## Atribución requerida por arXiv

Los términos de uso de la API (https://info.arxiv.org/help/api/tou.html) piden mostrar:

> "Gracias a arXiv por el uso de su interoperabilidad de acceso abierto."

Ya está agregada en la pantalla de Perfil de la app.
