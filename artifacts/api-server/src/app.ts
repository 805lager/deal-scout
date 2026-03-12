import express, { type Express } from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";
import router from "./routes";

const app: Express = express();

app.use(cors());

// Proxy MUST come before express.json() — the body parser consumes the
// request stream, leaving nothing for the proxy to forward. Python API
// would receive an empty body and hang waiting for data.
app.use(
  "/api/ds",
  createProxyMiddleware({
    target: "http://localhost:8000",
    changeOrigin: true,
    pathRewrite: { "^/api/ds": "" },
    proxyTimeout: 120000,
    timeout: 120000,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
