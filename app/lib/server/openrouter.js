import "server-only";
import OpenAI from "openai";
import { HttpError } from "./errors.js";

export function createCompletion(parameters, options) {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new HttpError(503, "CONFIGURATION_ERROR", "Chat service is not configured correctly.");
  }
  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    maxRetries: 0,
    timeout: 60000,
  });
  return client.chat.completions.create(parameters, options);
}

export function upstreamError(error) {
  if (error instanceof HttpError) return error;
  if (error.status === 429) {
    return new HttpError(429, "UPSTREAM_RATE_LIMITED", "The model provider is busy. Please try again later.");
  }
  if (error.status === 503 || error.name === "APIConnectionError" || error.name === "APIConnectionTimeoutError") {
    return new HttpError(503, "UPSTREAM_UNAVAILABLE", "The model provider is temporarily unavailable.");
  }
  return new HttpError(502, "UPSTREAM_ERROR", "The model provider could not complete the request.");
}
