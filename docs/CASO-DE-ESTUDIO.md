# Caso de estudio: un incidente de envíos y el rediseño *fail-closed*

> Postmortem real de este sistema, anonimizado. Lo incluyo porque el *cómo* se
> resolvió dice más de mi forma de trabajar que el código en verde: diagnóstico
> de causa raíz, una decisión de diseño que invierte el modo de fallo, y una
> auditoría que deja el sistema mejor de lo que estaba antes del incidente.

---

## Contexto

El sistema automatiza el ciclo de vida de cotizaciones: descarga desde un ERP,
crea negocios en el CRM, envía correos de seguimiento al cliente (día 0, 3 y 7) y
cierra por silencio al día hábil 21. Corre en producción y **le escribe a clientes
reales**. Ese último detalle es el que convierte cualquier bug en un incidente.

## Qué pasó

Durante el refactor del modelo de estados se enviaron correos a destiempo a un grupo
de clientes — algunos repetidos varias veces (los clientes con varias cotizaciones
recibían un correo por cada una).

Punto importante para dimensionar: **no fueron correos erróneos ni a clientes
equivocados.** Cada correo era un seguimiento legítimo sobre la cotización real de
ese cliente. El problema fue de *timing*: se reactivaron cotizaciones viejas que ya
no debían recibir nada.

## Causa raíz (la cadena completa)

1. **Migración no idempotente.** Usaba una misma columna como entrada y salida. Al
   correrla dos veces, la segunda pasada leyó su propia salida y ~126 filas
   históricas perdieron su marca → el sistema las volvió a tratar como "nuevas".
2. **Triggers sin pausar** durante el corte.
3. **Sin guarda de antigüedad** en la creación de negocios ni en los seguimientos →
   cotizaciones viejas entraron al flujo y dispararon correos.

Pero la causa raíz *de diseño*, la que hacía que todo esto terminara en correos,
era más profunda 👇

## El hallazgo de fondo: el sistema fallaba *abierto*

El modelo definía "estar en seguimiento activo" por la **ausencia** de una bandera:

```
activo  ≡  Etapa = "Cotizando"  ∧  Control vacío  ∧  tiene negocio
```

Es decir, *cualquier* función que **borrara** la columna de control reactivaba los
envíos en silencio. Para un sistema que le escribe a clientes, ese es el sentido
peligroso del modo de fallo: **ante cualquier error, tiende a mandar.**

Rastreando el código, el único camino que producía exactamente ese estado
(limpiar Control sin cambiar la Etapa) era una acción del panel que escribía la
bandera al instante. Además, otra función de reapertura por pedido hacía
`setValue('')` sobre Control "para limpiar Excluida/Archivada", pero de paso pisaba
también estados legítimos como "Respondida" o "Vinculada": un bug latente que
descongelaba envíos en cada reapertura.

## Qué hice

### 1. Kill-switch global independiente de los triggers

Un interruptor `ENVIOS_ACTIVOS` en las propiedades del script. Mientras no sea
exactamente `"SI"`, **ninguna** ruta de código manda correos ni cierra negocios —
loguean y salen. Es independiente de los triggers: garantiza "no sale nada" aunque
todo lo demás falle. Encenderlo es un acto deliberado.

> Por sí solo, este único cambio habría evitado el incidente.

### 2. Invertir el modo de fallo (de *fail-open* a *fail-closed*)

En vez de "sin bandera = seguir", el seguimiento pasa a depender de condiciones
**positivas y explícitas**. Un borrado accidental de la columna de control ya no
resucita envíos: si no está el estado correcto, no se manda. El default seguro es
**no molestar al cliente.**

### 3. Blindar todo borrado de estado

Ninguna función pisa un estado legítimo salvo de forma explícita y condicionada.
Se corrigió el `setValue('')` incondicional y se revisó la acción del panel para
que no actúe sobre datos viejos.

### 4. Idempotencia y guardas de antigüedad

- Guarda anti-re-ejecución en la migración (aborta si la columna ya está migrada).
- Guardas de antigüedad: no se crean negocios ni se envían/cierran correos para
  cotizaciones por encima de un umbral de días.
- Una sola función central de triggers (`configurarTodosLosTriggers`) + una
  `pausarSistema()` que los borra, eliminando los *footguns* de crear triggers
  parciales sueltos por archivo.

### 5. Separar producción de herramientas

El código one-shot de migración y las herramientas de diagnóstico se aíslan del
código de producción, para que nadie ejecute "para probar" algo que le escribe a
un cliente.

## Refuerzos posteriores (auditoría)

Tras estabilizar, una auditoría del panel agregó defensas en profundidad:

- **`LockService`** para que corridas solapadas no dupliquen correos.
- **Dedup por número de cotización** dentro de cada corrida.
- El panel y los resúmenes **espejan las guardas reales** (muestran lo que el motor
  realmente haría, no una aproximación).
- Un fallo de envío dispara una **alerta por correo** al operador (con *throttle*
  para no hacer spam).
- El asunto del resumen matutino lleva `[ENVÍOS OFF]` cuando el kill-switch está
  apagado, para que el estado sea imposible de ignorar.

## Lo que me llevo

- **Para un sistema con efectos externos, el modo de fallo es una decisión de
  diseño, no un detalle.** "¿Qué pasa si esto falla a medias?" debe tener una
  respuesta segura por construcción.
- **Un kill-switch barato y global vale más que diez guardas específicas.** Es la
  red que atrapa lo que no anticipaste.
- **Idempotencia no es opcional** cuando una migración toca datos que disparan
  acciones hacia afuera.
- Y la regla que quedó anotada en la memoria del proyecto: *nunca desplegar a
  producción sin un test interno exhaustivo, con el kill-switch apagado hasta
  validar.*
