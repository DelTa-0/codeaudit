// Curated lists of widely-used packages that typosquatters and slopsquatters
// most often impersonate. Kept as TS constants (not JSON) so they compile into
// dist/ via tsc and bundle cleanly into the esbuild CLI — no asset-copy step,
// no runtime file reads. Intentionally high-signal rather than exhaustive: a
// small list of genuinely popular names keeps edit-distance matches meaningful
// and false positives low (a real popular name is exempted, see typosquat.ts).
export const POPULAR_NPM: string[] = [
  "react", "react-dom", "lodash", "axios", "express", "chalk", "commander", "moment",
  "dotenv", "uuid", "typescript", "webpack", "vite", "eslint", "prettier", "jest",
  "mocha", "chai", "vue", "angular", "svelte", "next", "nuxt", "redux", "zustand",
  "immer", "rxjs", "graphql", "apollo-server", "mongoose", "sequelize", "prisma",
  "knex", "pg", "mysql2", "redis", "ioredis", "socket.io", "ws", "cors", "helmet",
  "morgan", "body-parser", "cookie-parser", "passport", "jsonwebtoken", "bcrypt",
  "bcryptjs", "argon2", "nodemailer", "winston", "pino", "debug", "yargs", "inquirer",
  "ora", "boxen", "figlet", "glob", "rimraf", "fs-extra", "chokidar", "nodemon",
  "concurrently", "cross-env", "husky", "lint-staged", "semver", "date-fns", "dayjs",
  "luxon", "classnames", "clsx", "styled-components", "tailwindcss", "postcss",
  "autoprefixer", "sass", "less", "rollup", "esbuild", "tsx", "ts-node", "nx", "turbo",
  "lerna", "zod", "yup", "joi", "ajv", "class-validator", "reflect-metadata", "formik",
  "react-hook-form", "react-router", "react-router-dom", "@tanstack/react-query", "swr",
  "recharts", "chart.js", "d3", "three", "framer-motion", "gsap", "lottie-web",
  "puppeteer", "playwright", "cheerio", "jsdom", "sharp", "multer", "formidable",
  "stripe", "aws-sdk", "@aws-sdk/client-s3", "googleapis", "firebase", "firebase-admin",
  "openai", "langchain", "cross-fetch", "node-fetch", "undici", "got", "superagent",
  "qs", "query-string", "form-data", "mime-types", "content-type",
];

export const POPULAR_PYPI: string[] = [
  "requests", "urllib3", "certifi", "charset-normalizer", "idna", "numpy", "pandas",
  "scipy", "matplotlib", "seaborn", "scikit-learn", "tensorflow", "torch", "keras",
  "transformers", "openai", "anthropic", "langchain", "llama-index", "flask", "django",
  "fastapi", "starlette", "uvicorn", "gunicorn", "pydantic", "sqlalchemy", "alembic",
  "psycopg2", "psycopg2-binary", "pymysql", "redis", "celery", "pika", "boto3",
  "botocore", "google-cloud-storage", "azure-storage-blob", "pytest", "pytest-cov",
  "tox", "nox", "black", "flake8", "pylint", "mypy", "ruff", "isort", "pre-commit",
  "click", "typer", "rich", "tqdm", "colorama", "python-dotenv", "pyyaml", "toml",
  "jinja2", "markupsafe", "beautifulsoup4", "lxml", "scrapy", "selenium", "playwright",
  "httpx", "aiohttp", "websockets", "pillow", "opencv-python", "imageio", "moviepy",
  "pytz", "python-dateutil", "arrow", "pendulum", "cryptography", "pyjwt", "passlib",
  "bcrypt", "paramiko", "python-multipart", "setuptools", "wheel", "pip", "poetry",
  "virtualenv", "six", "attrs", "packaging", "wrapt", "protobuf", "grpcio", "openpyxl",
  "xlrd", "pyarrow", "dask", "networkx", "sympy", "statsmodels",
];
