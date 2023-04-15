
import { defineConfig } from "vite";
import path from "path";

import typescript from "@rollup/plugin-typescript";
import { typescriptPaths } from "rollup-plugin-typescript-paths";

export default defineConfig({
    plugins: [],
    resolve: {
        alias: [
            {
                find: "~",
                replacement: path.resolve(__dirname, "./src"),
            },
        ],
    },
    server: { port: 3001 },
    build: {
        manifest: true,
        minify: true,
        reportCompressedSize: true,
        lib: {
            entry: path.resolve(__dirname, "src/main.ts"),
            fileName: "main",
            formats: ["es", "cjs"],
        },
        rollupOptions: {
            external: [],
            plugins: [
                typescriptPaths({ preserveExtensions: true }),
                typescript({
                    sourceMap: true,
                    declaration: true,
                    outDir: "dist",
                }),
            ],
        }
    }
});

