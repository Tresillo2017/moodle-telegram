# Alertas de faltas de asistencia (Alexia)

## Objetivo

Avisar por Telegram cuando el usuario se acerca a (o supera) el límite de
faltas de asistencia que le hace perder la evaluación continua en cada
asignatura, leyendo los datos de asistencia desde Alexia (sistema de gestión
académica de UCAM/FP San Antonio), que no tiene API pública.

## Regla de negocio

Política de centro, igual para todas las asignaturas: se pierde la
evaluación continua al superar el **30% de las horas lectivas** del módulo.
El límite en horas se calcula como:

```
límite_horas = horas_semanales × 19.5 semanas × 0.30
```

Límites por asignatura (curso 2026/2027, DAM 2º año):

| Asignatura (nombre en Alexia)                    | Horas/semana | Límite (h) |
|---------------------------------------------------|-------------:|-----------:|
| Acceso a Datos                                     | 5            | 29.25      |
| Desarrollo de Interfaces                           | 6            | 35.1       |
| Programación Multimedia y Dispositivos Móviles     | 4            | 23.4       |
| Programación de Servicios y Procesos               | 4            | 23.4       |
| Principios de Ciberseguridad                       | 2            | 11.0       |
| Sistemas de Gestión Empresarial                    | 5            | 29.25      |

Itinerario para la Empleabilidad II y el Proyecto Intermodular DAM quedan
fuera del sistema de alertas (sin horario de clase fijo / régimen distinto).

## Autenticación en Alexia

Alexia usa ASP.NET WebForms. El flujo de login observado:

1. `GET https://web2.alexiaedu.com/ACWeb/LogOn.aspx?key=NS2IrX8Iq04%3d`
   — la `key` es fija por institución (San Antonio) y da cookies
   `LogOnToken` (larga duración) + `AC_SessionId`.
2. Parsear del HTML devuelto los campos ocultos `__VIEWSTATE`,
   `__VIEWSTATE1..N`, `__VIEWSTATEFIELDCOUNT`, `__VIEWSTATEGENERATOR`,
   `__VIEWSTATEENCRYPTED`, `__EVENTVALIDATION`.
3. `POST` al mismo `action` del formulario con esos campos +
   `txtUsuario`, `txtPassword`, manteniendo las cookies del paso 1.
4. La respuesta (o su redirect) trae una cookie de sesión autenticada,
   válida para pedir la ficha de asistencia.

No se detectó captcaptcha, 2FA ni SSO. No hace falta navegador headless:
fetch + cookie jar manual es suficiente.

La estructura exacta del HTML de la ficha de asistencia (tabla de faltas por
asignatura) **no se ha podido verificar sin credenciales reales** — se
confirmará y ajustará el parser durante la implementación, contra la cuenta
real del usuario.

## Arquitectura

Nuevo módulo `src/alexia.ts`, paralelo a `src/moodle.ts`:

```ts
interface AlexiaAuth { cookies: string } // cookie jar serializado

async function loginAlexia(username: string, password: string): Promise<AlexiaAuth>
async function getAbsences(auth: AlexiaAuth): Promise<{ subject: string; absenceHours: number }[]>
```

`getAbsences` usa `HTMLRewriter` (disponible nativamente en Workers) para
extraer la tabla de faltas sin añadir dependencias.

Un mapa estático en `src/alexia.ts`:

```ts
const SUBJECT_HOURS: Record<string, number> = {
  "Acceso a Datos": 5,
  "Desarrollo de Interfaces": 6,
  "Programación Multimedia y Dispositivos Móviles": 4,
  "Programación de Servicios y Procesos": 4,
  "Principios de Ciberseguridad": 2,
  "Sistemas de Gestión Empresarial": 5,
};
```

(Se define en código, no en la base de datos: es una asignación fija del
curso académico y el bot es de un único usuario — cambiarla es editar un
número una vez al año.)

## Flujo de credenciales

Mismo patrón que Moodle: en la página `/connect` se añade un segundo
formulario para usuario/contraseña de Alexia. A diferencia de Moodle,
Alexia no expone un token de larga duración vía API — solo cookies de
sesión ligadas al login form. Por eso el worker debe repetir el login
completo (usuario + contraseña) en cada poll de 15 minutos, lo que obliga
a persistir la contraseña de Alexia en D1, sin cifrar (Workers no tiene
gestión de claves propia sin añadir un KV/Secret adicional). Esto es una
limitación real de Alexia, no una elección de diseño; se documenta
explícitamente en el README como tal.

## Esquema D1 (añadido a `schema.sql`)

```sql
ALTER TABLE users ADD COLUMN alexia_username TEXT;
ALTER TABLE users ADD COLUMN alexia_password TEXT;

CREATE TABLE IF NOT EXISTS absence_alerts (
  chat_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  threshold TEXT NOT NULL, -- '80pct' | '100pct'
  PRIMARY KEY (chat_id, subject, threshold)
);
```

## Flujo de polling (integrado en `runPoll` / `checkUser`)

Por cada usuario con `alexia_username` configurado:

1. Login a Alexia.
2. `getAbsences` → lista de `{ subject, absenceHours }`.
3. Por cada asignatura presente en `SUBJECT_HOURS`:
   - `limit = SUBJECT_HOURS[subject] * 19.5 * 0.30`
   - `ratio = absenceHours / limit`
   - Si `ratio >= 1` y no existe `absence_alerts(chat_id, subject, '100pct')`
     → enviar alerta 🚨 "límite superado", insertar fila.
   - Si no, si `ratio >= 0.8` y no existe fila `'80pct'` → enviar alerta ⚠️,
     insertar fila.
4. Fila de asignatura con nombre no reconocido en `SUBJECT_HOURS` → se
   ignora silenciosamente (no rompe el resto).

## Manejo de errores

- Login de Alexia falla (credenciales inválidas, cambio de estructura del
  sitio) → se loguea con `console.error` y se salta ese usuario para ese
  ciclo, igual que ya hace `runPoll` con Moodle. No afecta al resto de
  usuarios ni a las notificaciones de Moodle.
- Ninguna excepción de Alexia debe interrumpir el procesado de Moodle del
  mismo usuario (llamadas independientes, cada una en su propio try/catch
  dentro de `checkUser`).

## Comandos nuevos

- `/faltas` (y botón en el teclado): muestra el estado actual de faltas por
  asignatura (horas usadas / límite, %), bajo demanda, igual patrón que
  `/assignments`.

## Fuera de alcance

- Tests automatizados (el repo no tiene test runner hoy; se verifica
  manualmente contra la cuenta real durante implementación).
- Parametrizar el 30% o las horas por asignatura desde Telegram — se edita
  en código si cambia el curso siguiente.
