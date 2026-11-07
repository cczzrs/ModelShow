// JKRD7 §7.3: compare paths by segments, JKI before JKS, numeric IDs.
export const JKI_ID = /^Q[1-9][0-9]*$/;
export const JKS_ID = /^G[1-9][0-9]*$/;
export const JKI_PATH = /^(?:G[1-9][0-9]*\.)+Q[1-9][0-9]*$/;
export const JKS_PATH = /^G[1-9][0-9]*(?:\.G[1-9][0-9]*)*$/;

export function comparePaths(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] === right[i]) continue;
    if (left[i][0] !== right[i][0]) return left[i][0] === 'Q' ? -1 : 1;
    // IDs have no leading zeroes. Comparing digit lengths avoids rounding large IDs.
    const x = left[i].slice(1), y = right[i].slice(1);
    if (x.length !== y.length) return x.length - y.length;
    return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

export function parentPath(path) {
  return path.slice(0, path.lastIndexOf('.'));
}

export function isDescendant(path, group) {
  return path.startsWith(`${group}.`);
}
