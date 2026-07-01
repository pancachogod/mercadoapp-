import { useEffect, useRef, useState } from 'react';
import { recognize } from 'tesseract.js';

const moneyFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const SAVED_PRODUCTS_KEY = 'shopping-camera-products';
const IGNORED_NAME_WORDS = [
  'ahorro',
  'antes',
  'barcode',
  'cambio',
  'codigo',
  'cop',
  'descuento',
  'fecha',
  'iva',
  'oferta',
  'precio',
  'subtotal',
  'supermercado',
  'total',
  'unidad',
  'unid',
];

function priceToPesos(value) {
  return Number(value.replace(/\D/g, ''));
}

function formatPesos(pesos) {
  return moneyFormatter.format(pesos);
}

function uniqueValues(values) {
  return Array.from(new Set(values));
}

function getSavedProducts() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_PRODUCTS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveProductPrice(barcode, product) {
  if (!barcode) {
    return;
  }

  const savedProducts = getSavedProducts();
  localStorage.setItem(
    SAVED_PRODUCTS_KEY,
    JSON.stringify({
      ...savedProducts,
      [barcode]: product,
    }),
  );
}

async function getProductByBarcode(code) {
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json`);

  if (!response.ok) {
    throw new Error('No se pudo consultar el producto.');
  }

  const data = await response.json();
  if (data.status !== 1) {
    return '';
  }

  return data.product.product_name || data.product.generic_name || data.product.brands || '';
}

function getPriceCandidatesFromText(text) {
  return text
    .split('\n')
    .flatMap((line, lineIndex) => {
      const matches = line.matchAll(/(?:\$|COP|COL\$)?\s*(\d{1,3}(?:[.,\s]\d{3})+|\d{4,7})(?:[,.)]\d{2})?/gi);

      return Array.from(matches, (match) => {
        const value = priceToPesos(match[1]);
        const lowerLine = line.toLowerCase();
        let score = 0;

        if (value < 100 || value > 2000000) {
          score -= 100;
        }
        if (/\$|cop|col\$/i.test(match[0])) {
          score += 5;
        }
        if (/precio|oferta|antes|ahora|unidad|unid|total|subtotal/i.test(line)) {
          score += 3;
        }
        if (/codigo|barra|nit|tel|factura|fecha|iva/i.test(lowerLine)) {
          score -= 5;
        }
        if (value >= 500 && value <= 300000) {
          score += 2;
        }

        return { value, score, lineIndex };
      });
    })
    .filter((candidate) => candidate.value >= 100 && candidate.value <= 2000000)
    .sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex || b.value - a.value);

}

function extractPriceCandidatesFromText(text) {
  const candidates = getPriceCandidatesFromText(text);
  const values = [];

  for (const candidate of candidates) {
    if (!values.includes(candidate.value)) {
      values.push(candidate.value);
    }
    if (values.length === 4) {
      break;
    }
  }

  return values;
}

function extractPriceFromText(text) {
  const candidates = getPriceCandidatesFromText(text);

  return candidates[0]?.value || 0;
}

function guessProductNameFromText(text) {
  const candidates = text
    .split('\n')
    .map((value) => value.replace(/[^\p{L}\p{N}\s%.-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((value, index) => {
      const lowerValue = value.toLowerCase();
      const letters = value.match(/\p{L}/gu)?.length || 0;
      const digits = value.match(/\d/g)?.length || 0;
      let score = letters * 2 - digits * 3;

      if (value.length >= 5 && value.length <= 55) {
        score += 4;
      }
      if (/\d{1,3}(?:[.,\s]\d{3})+|\$|cop/i.test(value)) {
        score -= 12;
      }
      if (IGNORED_NAME_WORDS.some((word) => lowerValue.includes(word))) {
        score -= 10;
      }
      if (/^[\d\s.,-]+$/.test(value)) {
        score -= 20;
      }

      return { value, score, index };
    })
    .filter((candidate) => candidate.score > 3)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return candidates[0]?.value || '';
}

function createOcrCanvas(sourceCanvas, mode = 'contrast') {
  const maxSide = 1800;
  const scale = Math.min(maxSide / Math.max(sourceCanvas.width, sourceCanvas.height), mode === 'original' ? 1 : 1.35);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);

  if (mode === 'original') {
    return canvas;
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const contrast = mode === 'threshold' ? 2.15 : 1.75;
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
    const sharpened = mode === 'threshold' ? (contrasted > 145 ? 255 : 0) : contrasted > 170 ? 255 : contrasted < 85 ? 0 : contrasted;

    data[index] = sharpened;
    data[index + 1] = sharpened;
    data[index + 2] = sharpened;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

async function recognizeTextFromCanvas(canvas) {
  const texts = [];

  for (const mode of ['contrast', 'threshold', 'original']) {
    const ocrCanvas = createOcrCanvas(canvas, mode);
    const result = await recognize(ocrCanvas, 'spa+eng', {
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '6',
    });

    texts.push(result.data.text);
  }

  return uniqueValues(texts.flatMap((text) => text.split('\n').map((line) => line.trim()).filter(Boolean))).join('\n');
}

async function improveCameraTrack(stream) {
  const [track] = stream.getVideoTracks();

  if (!track?.getCapabilities || !track.applyConstraints) {
    return;
  }

  const capabilities = track.getCapabilities();
  const advanced = [];

  if (capabilities.focusMode?.includes('continuous')) {
    advanced.push({ focusMode: 'continuous' });
  }
  if (capabilities.exposureMode?.includes('continuous')) {
    advanced.push({ exposureMode: 'continuous' });
  }
  if (capabilities.whiteBalanceMode?.includes('continuous')) {
    advanced.push({ whiteBalanceMode: 'continuous' });
  }
  if (capabilities.zoom?.max && capabilities.zoom.max >= 1.25) {
    advanced.push({ zoom: Math.min(1.4, capabilities.zoom.max) });
  }

  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch {
      // Some mobile browsers expose capabilities but reject individual constraints.
    }
  }
}

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [photo, setPhoto] = useState('');
  const [barcode, setBarcode] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [priceCandidates, setPriceCandidates] = useState([]);
  const [quantity, setQuantity] = useState('1');
  const [recognitionStatus, setRecognitionStatus] = useState('');
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [items, setItems] = useState([]);

  const totalPesos = items.reduce((sum, item) => sum + item.pricePesos * item.quantity, 0);
  const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);

  useEffect(() => {
    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Este navegador no permite usar la camara.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
          audio: false,
        });

        await improveCameraTrack(stream);
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraReady(true);
      } catch {
        setCameraError('No se pudo abrir la camara. Revisa los permisos del navegador.');
      }
    }

    startCamera();

    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function recognizeProductFromCanvas(canvas) {
    setBarcode('');
    setPriceCandidates([]);
    setRecognitionStatus('Buscando codigo de barras, nombre y precio en la foto...');

    setIsRecognizing(true);
    try {
      let detectedName = '';
      let detectedPrice = 0;

      if ('BarcodeDetector' in window) {
        const detector = new window.BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
        });
        const codes = await detector.detect(canvas);

        if (codes.length > 0) {
          const detectedBarcode = codes[0].rawValue;
          const savedProduct = getSavedProducts()[detectedBarcode];
          setBarcode(detectedBarcode);

          if (savedProduct) {
            setName(savedProduct.name);
            setPrice(String(savedProduct.pricePesos));
            setRecognitionStatus('Producto reconocido. Nombre y precio cargados automaticamente.');
            return;
          }

          detectedName = await getProductByBarcode(detectedBarcode);
        }
      }

      setRecognitionStatus('Mejorando la foto y leyendo texto para encontrar nombre y precio...');
      const text = await recognizeTextFromCanvas(canvas);
      const detectedPriceCandidates = extractPriceCandidatesFromText(text);
      detectedPrice = extractPriceFromText(text);
      detectedName = detectedName || guessProductNameFromText(text);

      setPriceCandidates(detectedPriceCandidates);
      if (detectedName) {
        setName(detectedName);
      } else {
        setName('Producto detectado');
      }
      if (detectedPrice) {
        setPrice(String(detectedPrice));
      }

      if (detectedName && detectedPrice) {
        setRecognitionStatus('Nombre y precio detectados automaticamente. Revisa antes de sumar.');
      } else if (detectedName) {
        setRecognitionStatus('Nombre detectado. No se encontro un precio claro: acerca la camara a la etiqueta de precio.');
      } else if (detectedPrice) {
        setRecognitionStatus('Precio detectado. No se encontro un nombre claro, puedes editar el nombre antes de sumar.');
      } else {
        setRecognitionStatus('No se pudo detectar un precio claro. Toma la foto de frente, con buena luz y acercate a la etiqueta.');
      }
    } catch {
      setRecognitionStatus('No se pudo reconocer automaticamente. Intenta con una foto mas clara del codigo o la etiqueta.');
    } finally {
      setIsRecognizing(false);
    }
  }

  async function takePhoto() {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || !cameraReady) {
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    setPhoto(canvas.toDataURL('image/jpeg', 0.95));
    await recognizeProductFromCanvas(canvas);
  }

  function uploadPhoto(event) {
    const file = event.target.files?.[0];
    const canvas = canvasRef.current;

    if (!file || !canvas) {
      return;
    }

    const image = new Image();
    image.onload = async () => {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      setPhoto(canvas.toDataURL('image/jpeg', 0.95));
      await recognizeProductFromCanvas(canvas);
      URL.revokeObjectURL(image.src);
      event.target.value = '';
    };
    image.src = URL.createObjectURL(file);
  }

  function addProduct(event) {
    event.preventDefault();

    const pricePesos = priceToPesos(price);
    const numericQuantity = Number(quantity);
    if (!name.trim() || !photo || Number.isNaN(pricePesos) || pricePesos <= 0 || !Number.isInteger(numericQuantity) || numericQuantity <= 0) {
      return;
    }

    saveProductPrice(barcode, {
      name: name.trim(),
      pricePesos,
    });

    setItems((currentItems) => [
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        pricePesos,
        quantity: numericQuantity,
        barcode,
        photo,
      },
      ...currentItems,
    ]);
    setName('');
    setPrice('');
    setQuantity('1');
    setPhoto('');
    setBarcode('');
    setPriceCandidates([]);
    setRecognitionStatus('');
  }

  function removeProduct(id) {
    setItems((currentItems) => currentItems.filter((item) => item.id !== id));
  }

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">Control de compras</p>
          <h1>Fotografia tus productos y calcula el total exacto</h1>
          <p className="intro">
            Toma una foto o subela desde la galeria. La pagina intentara detectar automaticamente
            el nombre, el precio en pesos colombianos y la foto para calcular el total exacto.
          </p>
        </div>
        <div className="total-card">
          <span>Total</span>
          <strong>{formatPesos(totalPesos)}</strong>
          <small>{totalUnits} unidad{totalUnits === 1 ? '' : 'es'} en {items.length} producto{items.length === 1 ? '' : 's'}</small>
        </div>
      </section>

      <section className="content-grid">
        <div className="camera-panel panel">
          <h2>Camara</h2>
          <div className="camera-frame">
            {cameraError ? (
              <div className="camera-message">{cameraError}</div>
            ) : (
              <>
                <video ref={videoRef} autoPlay playsInline muted />
                <div className="scan-overlay" aria-hidden="true">
                  <span className="scan-corner top-left" />
                  <span className="scan-corner top-right" />
                  <span className="scan-corner bottom-left" />
                  <span className="scan-corner bottom-right" />
                  <p>{isRecognizing ? 'Analizando foto...' : 'Centra el nombre o la etiqueta de precio'}</p>
                </div>
              </>
            )}
          </div>
          <button className="primary-button" type="button" onClick={takePhoto} disabled={!cameraReady || isRecognizing}>
            {isRecognizing ? 'Reconociendo...' : 'Tomar foto'}
          </button>
          <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={isRecognizing}>
            Subir desde galeria
          </button>
          <input ref={fileInputRef} className="file-input" type="file" accept="image/*" capture="environment" onChange={uploadPhoto} />
          {recognitionStatus && <p className="recognition-status">{recognitionStatus}</p>}
          <canvas ref={canvasRef} hidden />
        </div>

        <form className="panel product-form" onSubmit={addProduct}>
          <h2>Nuevo producto</h2>
          <div className="photo-preview">
            {photo ? <img src={photo} alt="Producto capturado" /> : <span>La foto aparecera aqui</span>}
          </div>
          <label>
            Nombre del producto
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ej: Leche"
              type="text"
            />
          </label>
          <label>
            Precio
            <input
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="Ej: 2500"
              inputMode="numeric"
              type="text"
            />
          </label>
          {priceCandidates.length > 1 && (
            <div className="price-candidates" aria-label="Precios posibles detectados">
              <span>Precios posibles:</span>
              {priceCandidates.map((candidate) => (
                <button type="button" key={candidate} onClick={() => setPrice(String(candidate))}>
                  {formatPesos(candidate)}
                </button>
              ))}
            </div>
          )}
          <label>
            Cantidad
            <input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              min="1"
              placeholder="Ej: 3"
              inputMode="numeric"
              type="number"
            />
          </label>
          <p className="price-note">
            Si llevas varias unidades del mismo producto, cambia la cantidad y no necesitas tomar otra foto.
          </p>
          <button className="primary-button" type="submit" disabled={!photo || !name.trim() || priceToPesos(price) <= 0 || Number(quantity) <= 0}>
            Sumar producto
          </button>
        </form>
      </section>

      <section className="panel list-panel">
        <div className="list-header">
          <h2>Lista de compras</h2>
          <strong>{formatPesos(totalPesos)}</strong>
        </div>

        {items.length === 0 ? (
          <p className="empty-state">Todavia no hay productos. Toma una foto y agrega el precio.</p>
        ) : (
          <div className="items-list">
            {items.map((item) => (
              <article className="item-card" key={item.id}>
                <img src={item.photo} alt={item.name} />
                <div>
                  <h3>{item.name}</h3>
                  <p>{formatPesos(item.pricePesos)} x {item.quantity}</p>
                  <strong className="item-subtotal">{formatPesos(item.pricePesos * item.quantity)}</strong>
                </div>
                <button type="button" onClick={() => removeProduct(item.id)}>
                  Eliminar
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
