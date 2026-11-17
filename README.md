# Autoconfirmador Tiendanube

Marca como pagados los pedidos de Tiendanube cuyo pago por transferencia ya llegó. El bot de Telegram (Apps Script) detecta la transferencia y le pasa a este programa qué pedido confirmar.

- `worker.js`: lee los pedidos pendientes del panel de Tiendanube, se los manda al bot y marca como pagados los que el bot indica.
- Corre en GitHub Actions cada 5 minutos (`.github/workflows/tiendanube.yml`).
- Secretos necesarios: `TN_WEBAPP`, `TN_CLAVE`, `TN_TIENDA`, `TN_SESION`.
- `login.js`: abre Chrome en la Mac para iniciar sesión en Tiendanube y guardar la sesión (cuando haya que renovarla).
