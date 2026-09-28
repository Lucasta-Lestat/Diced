/// <reference types="jest" />
import { isValidGtin, lookupBarcode, normalizeGtin, parseOffProduct } from '../openfoodfacts';
import off from './fixtures/off.json';

describe('isValidGtin', () => {
  it.each([
    ['3017624010701', 'EAN-13 (Nutella)'],
    ['5449000000996', 'EAN-13 (Coca-Cola)'],
    ['049000042566', 'UPC-A'],
    ['96385074', 'EAN-8'],
    ['10012345678902', 'GTIN-14'],
    ['5 449000 000996', 'with spaces'],
  ])('accepts %s (%s)', (code) => {
    expect(isValidGtin(code)).toBe(true);
  });

  it.each([
    ['3017624010702', 'wrong check digit'],
    ['049000042567', 'wrong UPC check digit'],
    ['12345', 'bad length'],
    ['123456789012345', 'too long'],
    ['30176240107O1', 'letter'],
    ['00000000', 'all zeros'],
    ['', 'empty'],
  ])('rejects %s (%s)', (code) => {
    expect(isValidGtin(code)).toBe(false);
  });

  it('normalizes separators', () => {
    expect(normalizeGtin(' 5449-000 000996 ')).toBe('5449000000996');
  });
});

describe('parseOffProduct (live response shape)', () => {
  it('maps per-100 g nutriments', () => {
    expect(parseOffProduct(off.nutella, '3017624010701')).toEqual({
      code: '3017624010701',
      name: 'Nutella',
      brand: 'Ferrero',
      servingSizeG: null,
      per100g: { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9 },
      perServing: null,
    });
  });

  it('maps per-serving nutriments and the serving size', () => {
    const product = parseOffProduct(off.coke, '5449000000996');
    expect(product?.brand).toBe('COCA-COLA SERVICES SA/NV');
    expect(product?.servingSizeG).toBe(330);
    expect(product?.per100g).toEqual({ kcal: 42, proteinG: 0, carbsG: 10.6, fatG: 0 });
    expect(product?.perServing).toEqual({ kcal: 139, proteinG: 0, carbsG: 35, fatG: 0 });
  });

  it('falls back to kJ energy and numeric strings', () => {
    const body = {
      status: 1,
      product: { product_name: '', serving_quantity: '50', nutriments: { energy_100g: 418.4, proteins_100g: '10' } },
    };
    const product = parseOffProduct(body, '96385074');
    expect(product?.name).toBe('Barcode 96385074');
    expect(product?.per100g.kcal).toBeCloseTo(100);
    expect(product?.per100g.proteinG).toBe(10);
    expect(product?.servingSizeG).toBe(50);
  });

  it('derives per-100 g from a serving when only serving values exist', () => {
    const body = {
      status: 1,
      product: { product_name: 'Bar', serving_quantity: 40, nutriments: { 'energy-kcal_serving': 200, fat_serving: 8 } },
    };
    expect(parseOffProduct(body, '96385074')?.per100g).toEqual({ kcal: 500, proteinG: 0, carbsG: 0, fatG: 20 });
  });

  it('returns null when not found or without nutrition', () => {
    expect(parseOffProduct(off.notFound, '96385074')).toBeNull();
    expect(parseOffProduct({ status: 1, product: { product_name: 'Mystery' } }, '96385074')).toBeNull();
    expect(parseOffProduct('nonsense', '96385074')).toBeNull();
  });
});

describe('lookupBarcode', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it('fetches the product with a User-Agent and the needed fields', async () => {
    fetchMock.mockResolvedValue(response(200, off.nutella));
    const product = await lookupBarcode('3017624010701');
    expect(product?.name).toBe('Nutella');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://world.openfoodfacts.org/api/v2/product/3017624010701.json?fields=code,product_name,brands,serving_quantity,nutriments',
    );
    expect(init.headers['User-Agent']).toMatch(/^Diced\//);
  });

  it('returns null for an invalid code without calling the network', async () => {
    expect(await lookupBarcode('1234567890123')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for unknown products (404) and network errors', async () => {
    fetchMock.mockResolvedValueOnce(response(404, off.notFound));
    expect(await lookupBarcode('96385074')).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(await lookupBarcode('96385074')).toBeNull();
    fetchMock.mockResolvedValueOnce(response(503, {}));
    expect(await lookupBarcode('96385074')).toBeNull();
  });
});
