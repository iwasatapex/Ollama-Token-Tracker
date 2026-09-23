const testExpression = /(^|\/|\\)(?:((?:u[0-9a-f]{4,6},?)+)-)(.+)\.svg$/i;

export function fileSorter(fileA: string, fileB: string) {
  const hasUnicodeA = testExpression.test(fileA);
  const hasUnicodeB = testExpression.test(fileB);

  if (hasUnicodeA == hasUnicodeB) {
    // just compare alphabetically
    const fileA_ = fileA.substring(0, fileA.lastIndexOf('.'));
    const fileB_ = fileB.substring(0, fileB.lastIndexOf('.'));
    return fileA_ < fileB_ ? -1 : 1;
  } else {
    // map true to 0, because we want it to be first
    return (hasUnicodeA ? 0 : 1) - (hasUnicodeB ? 0 : 1);
  }
}
