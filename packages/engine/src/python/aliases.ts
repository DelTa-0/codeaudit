/**
 * Import-name → PyPI-distribution-name aliases for the well-known cases
 * where they differ. Applied before registry lookups so `import cv2`
 * resolves to the real `opencv-python` distribution instead of a phantom.
 * Keys are the top-level import names as they appear in source; values are
 * PEP 503-normalized distribution names.
 */
export const IMPORT_TO_PYPI: Record<string, string> = {
  cv2: "opencv-python",
  yaml: "pyyaml",
  sklearn: "scikit-learn",
  PIL: "pillow",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  dotenv: "python-dotenv",
  jose: "python-jose",
  magic: "python-magic",
  slugify: "python-slugify",
  Crypto: "pycryptodome",
  OpenSSL: "pyopenssl",
  wx: "wxpython",
  serial: "pyserial",
  usb: "pyusb",
  win32api: "pywin32",
  win32com: "pywin32",
  github: "pygithub",
  gi: "pygobject",
  cairo: "pycairo",
  MySQLdb: "mysqlclient",
  attr: "attrs",
  pkg_resources: "setuptools",
  setuptools: "setuptools",
};

/** PEP 503 normalization: lowercase, runs of -_. collapse to a single -. */
export function normalizePyPiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Maps a top-level import name to the PyPI distribution name to check. */
export function importNameToDistribution(importName: string): string {
  return normalizePyPiName(IMPORT_TO_PYPI[importName] ?? importName);
}
