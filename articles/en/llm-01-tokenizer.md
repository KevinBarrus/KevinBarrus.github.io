# Tokenizer: How Text Becomes Model Input

Large language models can't process text directly. To a model:

```text
I love AI
```

or even:

```text
我喜欢 AI
```

None of these are directly computable. Neural networks ultimately only process numbers. So before text actually enters the model, it has to go through one step:

```text
text
↓
UTF-8 encoding
↓
byte sequence
↓
Tokenizer
↓
Token ID
↓
model
```

What the tokenizer does is convert text into a sequence of integers.


## 1. What does the tokenizer actually see?

The tokenizer doesn't directly "see":

```text
我
喜欢
AI
```

and then think about how to split it into words.

For the byte-level tokenizers used by many modern LLMs, text is first converted into bytes via UTF-8 encoding. For example, an English character:

```text
A
```

takes only 1 byte in UTF-8:

```text
41
```

Whereas a common Chinese character usually takes 3 bytes. So:

```text
text
↓
UTF-8
↓
a string of bytes
```

The basis on which the tokenizer actually performs splitting and merging is these bytes and the fragments made up of them. So a more accurate flow is:

```text
Text
↓
Bytes
↓
Tokens
↓
Token IDs
```

## 2. What is a token?

A token can be understood as: a sequence of bytes that the tokenizer finally decides to process as one unit. From a human perspective it may correspond to:

- a whole word
- part of a word
- a single Chinese character
- several Chinese characters
- a punctuation mark
- a space
- a piece of code
- or even just part of the bytes of a character

For example:

```text
playing
```

might be split into:

```text
play
ing
```

or the whole thing might be one token.

This isn't because the tokenizer understands English grammar, but because these byte combinations appear frequently enough in the training data.

## 3. Why not make every byte a token?

Theoretically you could. Because as long as you cover all bytes, you can represent any UTF-8 text. But that would make the sequence too long. For example, an English word:

```text
transformer
```

if processed entirely byte-by-byte, would basically be split into:

```text
t r a n s f o r m e r
```

many tokens. And Chinese characters usually need multiple UTF-8 bytes on their own, so with no merging at all they'd be even more fragmented. The more tokens there are, the longer the sequence the model has to process downstream. So we want to combine bytes that frequently appear together.


## 4. Why not make every word a token?

The other extreme is:

```text
I love artificial intelligence
```

split directly into:

```text
I
love
artificial
intelligence
```

That looks simple. But the problem is that the words, names, code, URLs, and newly coined terms in the world are almost infinite. For example:

```text
play
playing
played
player
```

If each is stored separately, they'd take up many tokens. And when you encounter a brand-new string you've never seen, it's hard to handle it directly. So modern tokenizers usually use a compromise: **subword tokenization.**


## 5. Subword: keep common parts whole, split uncommon ones

The core idea is simple: merge common byte combinations into larger tokens as much as possible, and split rare content into smaller parts.

For example:

```text
playing
```

might become:

```text
play
ing
```

So that:

```text
playing
played
player
```

can share:

```text
play
```

instead of every complete word taking up its own slot.


## 6. How do we know to split it this way?

One classic method is called **BPE**. Its core process can be understood as: start from smaller units, repeatedly find the adjacent fragments that most often appear together, then merge them. For example, if the training data frequently contains:

```text
hug
hug
hug
hugs
```

At first you can view them as smaller units:

```text
h u g
h u g
h u g
h u g s
```

Count the adjacent pairs:

```text
h + u
u + g
g + s
```

If:

```text
h + u
```

is very common, merge them:

```text
h + u
↓
hu
```

Then it might continue:

```text
hu + g
↓
hug
```

Finally:

```text
hug
```

becomes a token.

For byte-level BPE the underlying idea is the same, except what actually participates in merging are bytes and already-merged byte fragments.


## 7. The tokenizer doesn't understand linguistics

This is important. If:

```text
playing
```

is split into:

```text
play + ing
```

it's not because the tokenizer knows that:

```text
play is the root
ing is the suffix
```

It just discovered in the training data that these byte combinations appear frequently. If another split were statistically more suitable, it could perfectly well split it into:

```text
pla
ying
```

So what the tokenizer essentially does is statistical compression, not language understanding.


## 8. Vocabulary: the table between tokens and numbers

After the tokenizer finishes training, it produces a vocabulary. For example:

```text
I        -> 100
love     -> 521
AI       -> 830
play     -> 1204
ing      -> 341
```

So:

```text
I love AI
```

after the tokenizer, might become:

```text
[100, 521, 830]
```

These numbers are the **token IDs**.

## 9. Token IDs are just indices

Suppose:

```text
AI -> 830
play -> 1204
```

It doesn't mean that:

```text
1204 > 830
```

has any linguistic meaning. Token IDs are just indices. Like in a database:

```text
user_id = 830
```

It only tells the model: this is the 830th token in the vocabulary. So:

```text
text
↓
UTF-8 bytes
↓
Token
↓
Token ID
```

At this point, the tokenizer's job is basically done.


## 10. What the model actually processes is not the token IDs

The model won't directly take:

```text
[100, 521, 830]
```

and compute with it as if it had linguistic meaning. Next, based on these IDs it finds the string of numbers corresponding to each token.

For example:

```text
100
↓
[0.2, -0.7, 0.1, ...]

521
↓
[0.8, 0.3, -0.2, ...]
```

These numbers are what actually enter the Transformer. So the complete flow is:

```text
text
↓
UTF-8
↓
byte sequence
↓
Tokenizer
↓
Token ID
↓
find the numbers corresponding to each token
↓
Transformer
```

The tokenizer is responsible for the first half.

## 11. How to find the numbers from an ID

This step is essentially a table lookup. Suppose the tokenizer outputs:

```text
[100, 521, 830]
```

Inside the model there's a very large table, with one row per token ID. For convenience, suppose the vocabulary has only 5 tokens and each token is represented by 4 numbers:

```text
ID 0 -> [ 0.2, -0.1,  0.7,  0.3]
ID 1 -> [-0.4,  0.8,  0.1, -0.2]
ID 2 -> [ 0.6,  0.5, -0.3,  0.9]
ID 3 -> [ 0.1, -0.7,  0.4,  0.2]
ID 4 -> [ 0.9,  0.2,  0.3, -0.5]
```

If the input token IDs are:

```text
[1, 4, 2]
```

Then you directly look up:

```text
ID 1 -> [-0.4, 0.8, 0.1, -0.2]
ID 4 -> [ 0.9, 0.2, 0.3, -0.5]
ID 2 -> [ 0.6, 0.5,-0.3,  0.9]
```

So the model gets:

```text
[
  [-0.4, 0.8, 0.1, -0.2],
  [ 0.9, 0.2, 0.3, -0.5],
  [ 0.6, 0.5,-0.3, 0.9]
]
```

This step is called embedding lookup. You can first understand it as: the token ID is a row number, and the model uses that row number to fetch the corresponding row of numbers from a table.

This table isn't produced by training the tokenizer; it's one of the LLM's own parameters. When the model first starts training, these numbers are basically random. During training, they're continuously adjusted through backpropagation. For example, at first:

```text
dog -> [0.91, -0.32, 0.18, ...]
cat -> [-0.44, 0.72, 0.09, ...]
```

You might ask: why are dog and cat these vectors? Can't they be some other numbers?

In fact, at first these values are completely meaningless. But after the model trains on lots of text, these numbers keep being adjusted. Eventually, tokens like dog, cat, and animal that frequently appear in similar contexts tend to form similar structures in their numerical representations.

So the key is:

- The tokenizer handles: text -> token ID
- The model's embedding table handles: token ID -> a string of numbers


In short, these numbers are not decided by the tokenizer. The tokenizer only decides:

```text
AI -> 830
```

As for:

```text
830 -> [0.23, -0.91, 0.44, ...]
```

what this string of numbers is — that's learned by the model.


## 12. Why does Chinese usually consume more tokens?

There are two reasons.

The first comes from UTF-8. English ASCII characters usually need only 1 byte, while common Chinese characters usually need 3 bytes.

So in the initial representation of a byte-level tokenizer, Chinese itself produces more bytes. But that doesn't mean 1 Chinese character = 3 tokens, because the tokenizer keeps merging afterwards.

The second reason is more important: which high-frequency byte combinations the tokenizer actually learned during training.

If the training data contains a lot of English, then:

```text
the
ing
computer
tion
```

these strings are very likely merged into large tokens. An English word that originally has many bytes may end up occupying just 1 token.

If Chinese training data is relatively scarce, then common Chinese combinations may not be sufficiently merged. So for the same amount of information, Chinese may need more tokens.

So what really determines token efficiency is UTF-8 byte length + the merging rules the tokenizer learned.

## 13. What does having more tokens mean?

An LLM's context length is usually measured in tokens. For example:

```text
128k context
```

means it can process at most roughly:

```text
128000 tokens
```

not 128000 characters. So if the same piece of information is:

```text
Language A -> 20 tokens
Language B -> 30 tokens
```

Language B will:

- fill up the context window faster
- produce more input tokens
- cost more at inference
- make the sequence the Transformer later processes longer

So how friendly the tokenizer is to a language directly affects the model's efficiency.


## 14. What is the tokenizer essentially doing?

You can understand it as a compression problem. We want the number of token types not to be infinite, and at the same time we don't want a piece of text to be split into too many tokens. So the tokenizer tends to:

```text
common byte combinations
↓
merged into larger tokens

rare byte combinations
↓
kept as smaller tokens
```

ultimately using a finite vocabulary to represent almost any text.


## 15. The complete flow

The whole process can be condensed into:

```text
text
↓
UTF-8 encoding
↓
bytes
↓
merge according to the trained rules
↓
Token
↓
Token ID
↓
subsequent model computation
```

When generating text in reverse:

```text
Token ID
↓
Token
↓
bytes
↓
UTF-8 decoding
↓
text
```

So the tokenizer sits between human text and the neural network. It converts arbitrary text into a sequence of discrete indices, then turns the generated indices back into human-readable text.

## 16. Hands-On

Use a real tokenizer to get a feel for how text actually becomes a sequence of token IDs.

```python
import tiktoken

tokenizer = tiktoken.get_encoding("gpt2")

text = "I love large language model"
ids = tokenizer.encode(text)
tokens = [tokenizer.decode([i]) for i in ids]

print(f"Text: {text}")
print(f"token IDs: {ids}")
print(f"tokens: {tokens}")

print(f"\nGPT-2 vocabulary size: {tokenizer.n_vocab}")
print("First 20 vocabulary entries (ID → Token):")

for token_id in range(20):
    token = tokenizer.decode([token_id])
    print(f"    ID {token_id:>2} → {token!r}")
```

`encode` is exactly what we covered in the explanation part — converting text into a sequence of token IDs — while `decode` converts a sequence of token IDs back into the corresponding text.

The output:

```python
tokens: ['I', ' love', ' large', ' language', ' model']

GPT-2 vocabulary size: 50257
First 20 vocabulary entries (ID → Token):
    ID  0 → '!'
    ID  1 → '"'
    ID  2 → '#'
    ID  3 → '$'
    ID  4 → '%'
    ID  5 → '&'
    ID  6 → "'"
    ID  7 → '('
    ID  8 → ')'
    ID  9 → '*'
    ID 10 → '+'
    ID 11 → ','
    ID 12 → '-'
    ID 13 → '.'
    ID 14 → '/'
    ID 15 → '0'
    ID 16 → '1'
    ID 17 → '2'
    ID 18 → '3'
    ID 19 → '4'
```

## Summary

The tokenizer's most core job is just three steps:

```text
text
↓
UTF-8 bytes

bytes
↓
Token

Token
↓
Token ID
```

For a byte-level tokenizer, it doesn't directly understand "Chinese", "English", or "words"; what it sees at the base level is bytes.

Algorithms like BPE then combine bytes that frequently appear together into larger tokens, based on the statistical patterns in the training data. Finally:

```text
Text
↓
Bytes
↓
Tokens
↓
Token IDs
```

The tokenizer's job ends here.

The next step is turning these token IDs into the string of numbers that actually goes into the Transformer for computation.
