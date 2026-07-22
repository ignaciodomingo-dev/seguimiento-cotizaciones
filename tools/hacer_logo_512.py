"""
Convierte el logo de Mi Empresa a 512x512 con fondo blanco (formato requerido por Slack).
Uso: python3 hacer_logo_512.py /ruta/al/logo.png
"""
import sys, os
from PIL import Image

if len(sys.argv) < 2:
    print("Uso: python3 hacer_logo_512.py /ruta/al/logo.png")
    sys.exit(1)

entrada = sys.argv[1]
salida  = os.path.splitext(entrada)[0] + "_512.png"

img = Image.open(entrada).convert("RGBA")

# Fondo transparente 512x512
bg = Image.new("RGBA", (512, 512), (0, 0, 0, 0))

# Escalar el logo para que quepa con margen del 10%
max_lado = int(512 * 0.90)
img.thumbnail((max_lado, max_lado), Image.LANCZOS)

# Centrar
x = (512 - img.width)  // 2
y = (512 - img.height) // 2
bg.paste(img, (x, y), img)

bg.save(salida, "PNG", optimize=True)
print(f"Guardado: {salida}  ({img.width}x{img.height} → 512x512)")
