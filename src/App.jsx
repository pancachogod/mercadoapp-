import { useEffect, useRef, useState } from 'react';
import { recognize } from 'tesseract.js';

const moneyFormatter = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const SAVED_PRODUCTS_KEY = 'shopping-camera-products';

function priceToPesos(value) {
  return Number(value.replace(/\D/g, ''));
}

function formatPesos(pesos) {
  return moneyFormatter.format(pesos);
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

function extractPriceFromText(text) {
  const matches = text.match(/(?:\$|COP)?\s*(\d{1,3}(?:[.,\s]\d{3})+|\d{4,7})(?:,\d{2})?/gi) || [];
  const prices = matches
    .map((match) => priceToPesos(match))
    .filter((value) => value >= 100 && value <= 2000000);

  return prices.length > 0 ? Math.max(...prices) : 0;
}

function guessProductNameFromText(text) {
  const ignoredWords = ['total', 'precio', 'unidad', 'oferta', 'iva', 'supermercado', 'cop'];
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find((value) => {
      const lowerValue = value.toLowerCase();
      return (
        value.length >= 4 &&
        value.length <= 45 &&
        !/\d/.test(value) &&
        !ignoredWords.some((word) => lowerValue.includes(word))
      );
    });

  return line || '';
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
          video: { facingMode: 'environment' },
          audio: false,
        });

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

      setRecognitionStatus('Leyendo texto de la foto para encontrar el precio...');
      const result = await recognize(canvas, 'spa+eng');
      const text = result.data.text;
      detectedPrice = extractPriceFromText(text);
      detectedName = detectedName || guessProductNameFromText(text);

      if (detectedName) {
        setName(detectedName);
      }
      if (detectedPrice) {
        setPrice(String(detectedPrice));
      }

      if (detectedName && detectedPrice) {
        setRecognitionStatus('Nombre y precio detectados automaticamente. Revisa antes de sumar.');
      } else if (detectedName) {
        setRecognitionStatus('Nombre detectado automaticamente. No se encontro un precio claro en la foto.');
      } else if (detectedPrice) {
        setRecognitionStatus('Precio detectado automaticamente. No se encontro un nombre claro en la foto.');
      } else {
        setRecognitionStatus('No se pudo detectar nombre ni precio. Usa una foto donde se vea el codigo de barras o la etiqueta de precio.');
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
    setPhoto(canvas.toDataURL('image/jpeg', 0.88));
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
      setPhoto(canvas.toDataURL('image/jpeg', 0.88));
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
              <video ref={videoRef} autoPlay playsInline muted />
            )}
          </div>
          <button className="primary-button" type="button" onClick={takePhoto} disabled={!cameraReady || isRecognizing}>
            {isRecognizing ? 'Reconociendo...' : 'Tomar foto'}
          </button>
          <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={isRecognizing}>
            Subir desde galeria
          </button>
          <input ref={fileInputRef} className="file-input" type="file" accept="image/*" onChange={uploadPhoto} />
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
