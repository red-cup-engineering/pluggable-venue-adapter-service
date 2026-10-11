/** Pure EVM codec using the declared ethers supplier. No transport or wallet access. */
import { AbiCoder, ParamType, keccak256 as hashBytes, toUtf8Bytes } from "ethers";
const coder = AbiCoder.defaultAbiCoder();
export const integer = (value) => {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError("abi-integer-unsafe-number");
  return BigInt(value);
};
const typeName = (type) => {
  if (typeof type === "string") return type;
  if (type.array !== undefined) return `${typeName(type.array)}[]`;
  return `tuple(${type.tuple.map(typeName).join(",")})`;
};
function normalizedValue(type, value) {
  if (type.array !== undefined) return value.map((item) => normalizedValue(type.array, item));
  if (type.tuple !== undefined) return type.tuple.map((member, i) => normalizedValue(member, value[i]));
  if (/^u?int\d*$/u.test(type)) {
    const unsigned = type.startsWith("u"), width = type.slice(unsigned ? 4 : 3), bits = width === "" ? 256 : Number(width);
    if (!Number.isInteger(bits) || bits < 8 || bits > 256 || bits % 8 !== 0 || (width !== "" && width !== String(bits))) throw new TypeError("abi-integer-width-invalid");
    const big = integer(value), bound = 1n << BigInt(unsigned ? bits : bits - 1);
    if (unsigned && big < 0n) throw new RangeError("uint-negative");
    if (big >= bound || (!unsigned && big < -bound)) throw new RangeError("abi-integer-out-of-range");
    return big;
  }
  return type === "address" ? String(value).toLowerCase() : value;
}
export const keccak256 = (input) => hashBytes(typeof input === "string" ? toUtf8Bytes(input) : Uint8Array.from(input));
export const selectorOf = (signature) => keccak256(signature).slice(0, 10);
export function encode(types, values) {
  if (types.length !== values.length) throw new TypeError("abi-arity-mismatch");
  return coder.encode(types.map(typeName), types.map((type, i) => normalizedValue(type, values[i]))).slice(2);
}
function plain(type, value) {
  if (type.arrayChildren) return Array.from(value, (item) => plain(type.arrayChildren, item));
  if (type.components) return type.components.map((member, i) => plain(member, value[i]));
  return type.baseType === "address" ? value.toLowerCase() : value;
}
export function decode(types, data, start = 0) {
  if (!Number.isSafeInteger(start) || start < 0) throw new RangeError("abi-offset-invalid");
  const params = types.map((type) => ParamType.from(typeName(type)));
  const values = coder.decode(params, `0x${data.replace(/^0x/u, "").slice(start * 2)}`);
  return params.map((type, i) => plain(type, values[i]));
}
