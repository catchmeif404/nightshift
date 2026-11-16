// An item is { sku: string, name: string, qty: number, price: number }.
export function totalValue(items) {
  return items.reduce((sum, item) => sum + item.qty * item.price, 0);
}

export function findByName(items, name) {
  return items.find((item) => item.name === name);
}
