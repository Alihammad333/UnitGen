// src/core/llm/ollamaClient.js
import OpenAI from "openai";
import "dotenv/config";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

export async function ollamaGenerate({
  model = DEFAULT_MODEL,
  prompt,
  temperature = 0.2,
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing. Add it to backend/.env");
  }

  const response = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      {
        role: "system",
        content:
          "You are an expert JavaScript Jest unit test generator. Return only the format requested by the user.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return response.choices?.[0]?.message?.content?.trim() || "";
}