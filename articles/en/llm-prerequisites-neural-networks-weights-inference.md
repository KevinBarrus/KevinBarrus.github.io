---
title: "LLM Prerequisites: Neural Networks, Weights, Inference"
createdAt: 2026-09-20 00:17
updatedAt: 2026-09-20 00:17
tags:
  - LLM
  - AI Infra
  - 深度学习
---

- Neural network: like the structure of the brain — what regions there are and how they connect
- Weights: the connection strength of the synapses between neurons
- Training: continuously adjusting these connection strengths so that the model predicts more and more accurately
- Inference: the connection strengths are fixed, the input signal travels once through the network, and the output comes out

Weights are trained. The rough process: random initialization → give the model text and let it predict the next token → compare the prediction with the true answer and compute the loss → backpropagation, computing each weight's responsibility for the error → use gradient descent to fine-tune each weight → repeat n times

Mathematically, a neural network can be seen as a function, and inference is carrying out this process: get the input → feed it to the neural network → get the output.

When we send a message to ChatGPT in the web UI, the message first reaches OpenAI's frontend/API servers, goes through authentication, rate limiting, safety review, and context construction, has the system prompt and history messages added, and is then cut into tokens by the tokenizer and enters the inference service. The inference service already has the model weights loaded, does forward computation on a GPU cluster, generates token by token, then goes through post-processing and safety filtering, and streams back to the browser.

As for local deployment, it is actually downloading the model weight files, config files, and so on, then installing an inference engine and running it on the local GPU/CPU.

The role of the inference engine reminds me of MySQL. MySQL lets you write a SELECT statement, but behind the scenes it has to parse, optimize, and execute, and at the bottom it has to deal with indexes, locks, MVCC, transactions, and these things.

The inference engine is similar: it exposes a simple interface and capabilities to the outside, and hides a large amount of complex work internally, including: scheduling and batching, KV Cache and GPU memory management, computation optimization, distributed parallelism, and so on.
