# LLM 02: Positional Encoding

In the previous post, we worked out how text becomes vectors. The full pipeline: text → byte sequence → tokens → token IDs → vectors. Converting the byte sequence into tokens relies on BPE; converting tokens into token IDs relies on the tokenizer; converting token IDs into vectors is a table lookup.

But this pipeline is still incomplete — you don't get a vector just by looking up a token ID.

## 1. Why Positional Encoding Is Needed

Suppose "Barrus" corresponds to vector A, "bit" corresponds to vector B, and "dog" corresponds to vector C. Then:

"the dog bit Barrus" → vectors `[C, B, A]`
"Barrus bit the dog" → vectors `[A, B, C]`

The two differ only in order. And a Transformer cannot perceive this difference in order.

I'll keep you in suspense here — we'll get to the exact reason when we cover attention. For now, think of it this way: a token attends to the tokens before it and after it, so it isn't sensitive to order.

And that's a serious problem. It's normal for a dog to bite Barrus — but I, the great Barrus, biting a dog? A mere swap in order completely changes the meaning.

So we need positional encoding to tell the LLM where each token sits.

## 2. Why Counting Up from Zero Doesn't Work

This is the strategy that comes to mind easily: if the vectors are `[A, B, C]`, give vector A a position encoding of 0, B one of 1, and C one of 2 — like an array.

This approach has two main problems.

### 2.1 Problem One

If the number of tokens is large, the position encoding values grow without bound and steal the show.

Analogy: everyone used to be equally broke, with assets all in `[-1, 1]` — then suddenly you're worth 50 million, and now everyone's eyes are on you.

### 2.2 Problem Two

Imagine a letter from Mio Akiyama to Barrus. It begins:

```text
Dear Barrus:
  xxx (5,000 words omitted)
```

And it ends:

```text
Barrus, I like you. Go out with me!
                                  Mio Akiyama
                                  Month 13, Day 45, 2077
```

For a child who doesn't yet understand language, is it really necessary to know that the 1st token is "Dear", or that tokens 12306–12308 are "I", "like", and "you"?

Obviously not. He only needs to know that "I", "like", and "you" show up together all the time, and that "I" and "you" are one position apart.

In other words, for an LLM, this is what we want: after seeing the position-encoding vectors of two tokens, it can recognize the transformation between the two vectors and infer how far apart they are — no matter where they appear in the sentence. It doesn't have to memorize "this word is at position 5, that word is at position 7"; instead, it has the opportunity to learn directly that "these two words are 2 positions apart".

## 3. The Solution: Encode with Sine and Cosine Functions of Different Frequencies

This isn't the only viable scheme — "learnable position vectors" achieve a similar effect, as discussed in the paper.

But the paper ultimately went with sine and cosine functions, because learnable position vectors have a limitation: they can only represent lengths seen during training. If training handled at most 512 tokens, position 513 has no reference to draw on.

Three benefits of trigonometric functions:

1. Bounded values: sin and cos always stay in `[-1, 1]` and never diverge as position grows

2. Extrapolable: since they are continuous functions, positions never seen in training can be encoded directly

3. Implicit relative positions: via trigonometric identities, the encoding of position pos+k can be obtained from the encoding of position pos through a linear transformation. This means the model can potentially learn "how far apart two tokens are", not just absolute position numbers

The formula:

$$
PE(pos,2i) = \sin\left(\frac{pos}{10000^{2i/d}}\right), \quad PE(pos,2i+1) = \cos\left(\frac{pos}{10000^{2i/d}}\right)
$$

Here pos is the position index, i indicates which sin/cos pair it is (counting from zero), and d is the total vector dimension. Even dimensions use sin; odd dimensions use cos.

For example: with a vector dimension of 8, a token's positional encoding consists of 8 numbers:

$$
\begin{bmatrix}
\sin\left(\frac{pos}{10000^{0/8}}\right) \\

\cos\left(\frac{pos}{10000^{0/8}}\right) \\[2ex]

\sin\left(\frac{pos}{10000^{2/8}}\right) \\

\cos\left(\frac{pos}{10000^{2/8}}\right) \\[2ex]

\sin\left(\frac{pos}{10000^{4/8}}\right) \\

\cos\left(\frac{pos}{10000^{4/8}}\right) \\[2ex]

\sin\left(\frac{pos}{10000^{6/8}}\right) \\

\cos\left(\frac{pos}{10000^{6/8}}\right)

\end{bmatrix}
$$

That's 4 sin/cos pairs of different frequencies. Simplified:

$$
\begin{aligned}
\text{Pair 1:} && \sin(pos), && \cos(pos) \\
\text{Pair 2:} && \sin(pos/10), && \cos(pos/10) \\
\text{Pair 3:} && \sin(pos/100), && \cos(pos/100) \\
\text{Pair 4:} && \sin(pos/1000), && \cos(pos/1000)
\end{aligned}
$$

This is what "different frequencies" means. Back in high school trigonometry, ω is the angular velocity, the period is 2π/ω, and frequency is the reciprocal of the period — so the larger ω is, the higher the frequency. Compared to sin x, sin 3x has a higher frequency: intuitively, the wave looks denser over the same span.

Using 10000 as the base is an empirical choice from the original paper. The larger the base, the wider the frequency gap between high and low frequencies, and the wider the range of positions the encoding can cover. 10000 works well for common sequence lengths (tens to thousands of tokens).

## 4. The Benefits

This design has two direct benefits.

### 4.1 Benefit One: No Collisions

Notice:

The smaller the dimension index, the smaller the denominator, and the higher the wave's frequency — the value changes noticeably with a slight shift in position, which is good for distinguishing adjacent positions.

The larger the dimension index, the larger the denominator, and the lower the frequency — values change slowly, which is good for carrying long-range positional relationships.

An intuitive example: the low-frequency dimensions are like a clock's hour hand — slow-moving, telling us roughly which period we're in; the high-frequency dimensions are like the second hand — fast-moving, pinpointing the exact moment.

Combine the two kinds of information and you can pin down a unique moment in time. Sinusoidal positional encoding works the same way: waves of different frequencies combine to give each position a unique vector.

You can also think of it as multiple hashing. Or, if frequency feels too abstract:

Suppose we need to find one person in the entire world. First we narrow the scope: this person is in China. But many people are in China, so we narrow further: which province, which city, gender, height, weight, wingspan, skin color, name, education... — each of these is a dimension.

With a single dimension — say you only look for people who are 176cm tall — you'll find plenty. But with multiple dimensions — 176cm tall, 75kg, male, East Asian, named Zhang Wei, with a bachelor's degree from Tsinghua University — you can quickly lock onto one specific person.

The more comparison dimensions, the harder it is to collide — and so each position's encoding won't repeat. Only then can different positions be told apart.

### 4.2 Benefit Two: The Transformation Depends Only on Distance, Not on the Original Position

Why is each pair sin + cos, rather than all sin or all cos?

Now for some derivation. All you need to remember is the angle-sum formulas for sine and cosine, plus matrix multiplication.

Assume the vector dimension is 4 and the token sits at position pos.

From the sinusoidal positional encoding formula:

$$
\begin{aligned}
PE(pos,2i) &= \sin\left(\frac{pos}{10000^{2i/d}}\right) \\
PE(pos,2i+1) &= \cos\left(\frac{pos}{10000^{2i/d}}\right)
\end{aligned}
$$

When d = 4, there are two sin/cos pairs.

The first pair:

$$
i=0:\quad 10000^{2\times0/4}=1
$$

$$
i=1:\quad 10000^{2\times1/4} = 10000^{1/2} = 100
$$

Therefore:

$$
P(pos)=
\begin{bmatrix}
\sin(pos)\\
\cos(pos)\\
\sin(pos/100)\\
\cos(pos/100)
\end{bmatrix}
$$

We can split it into two pairs:

$$
\begin{aligned}
P_0(pos) &= \begin{bmatrix} \sin(pos) \\ \cos(pos) \end{bmatrix} \\
P_1(pos) &= \begin{bmatrix} \sin(pos/100) \\ \cos(pos/100) \end{bmatrix}
\end{aligned}
$$

So:

$$
P(pos)=
\begin{bmatrix}
P_0(pos)\\
P_1(pos)
\end{bmatrix}
$$

Now we want to find:

$$
P(pos+k)
$$

First, the first pair:

$$
P_0(pos+k) =
\begin{bmatrix}
\sin(pos+k)\\
\cos(pos+k)
\end{bmatrix}
$$

By the angle-sum formulas:

$$
\begin{aligned}
\sin(pos+k) &= \sin(pos)\cos(k) + \cos(pos)\sin(k) \\
\cos(pos+k) &= \cos(pos)\cos(k) - \sin(pos)\sin(k)
\end{aligned}
$$

Therefore:

$$
P_0(pos+k) =
\begin{bmatrix}
\cos(k) & \sin(k)\\
-\sin(k) & \cos(k)
\end{bmatrix}
\begin{bmatrix}
\sin(pos)\\
\cos(pos)
\end{bmatrix}
$$

Define:

$$
M_0(k)=
\begin{bmatrix}
\cos(k) & \sin(k)\\
-\sin(k) & \cos(k)
\end{bmatrix}
$$

Then:

$$
P_0(pos+k)=M_0(k)P_0(pos)
$$

The second pair works the same way:

$$
P_1(pos+k) =
\begin{bmatrix}
\sin((pos+k)/100)\\
\cos((pos+k)/100)
\end{bmatrix}
$$

Note:

$$
\frac{pos+k}{100} = \frac{pos}{100} + \frac{k}{100}
$$

So:

$$
P_1(pos+k) =
\begin{bmatrix}
\cos(k/100) & \sin(k/100)\\
-\sin(k/100) & \cos(k/100)
\end{bmatrix}
\begin{bmatrix}
\sin(pos/100)\\
\cos(pos/100)
\end{bmatrix}
$$

Define:

$$
M_1(k)=
\begin{bmatrix}
\cos(k/100) & \sin(k/100)\\
-\sin(k/100) & \cos(k/100)
\end{bmatrix}
$$

Thus:

$$
P_1(pos+k)=M_1(k)P_1(pos)
$$

So the complete four-dimensional positional encoding:

$$
P(pos+k) =
\begin{bmatrix}
M_0(k) & 0\\
0 & M_1(k)
\end{bmatrix}
\begin{bmatrix}
P_0(pos)\\
P_1(pos)
\end{bmatrix}
$$

Define the block-diagonal matrix:

$$
M(k)=
\begin{bmatrix}
M_0(k) & 0\\
0 & M_1(k)
\end{bmatrix}
$$

Finally:

$$
\boxed{P(pos+k)=M(k)P(pos)}
$$

The key is in this last equation: for any fixed relative distance k, M(k) depends only on k, not on pos.

For example, with k = 3:

$$
\begin{aligned}
P(13) &= M(3)P(10) \\
P(103) &= M(3)P(100) \\
P(1003) &= M(3)P(1000)
\end{aligned}
$$

So "moving back 3 positions" corresponds to the same linear transformation no matter where in the sequence it happens. This is the mathematical foundation for sinusoidal positional encoding to provide generalizable relative-position information.

The model doesn't need to learn what 10 → 13 is, what 100 → 103 is, or what 1000 → 1003 is — it only needs the opportunity to learn the general class of "+3" relationships.

This matters a lot for the model, because language usually calls for things like: the previous token, the next token, 2 positions earlier, 5 tokens apart — not rote memorization of position 198 or position 36.

Besides, much of what a Transformer does already involves matrix multiplication, linear transformations, and dot products. So if the relative distance k can itself take the form of a fixed linear transformation, the model finds it all the easier to exploit within the kind of computation it is already good at.

## 5. How It Merges with the Token Embedding

With position information in hand, the next decision is how to combine it with the token embedding. The two most intuitive options are addition and concatenation.

Concatenation joins the token vector and the position vector end to end into one longer vector. If the token vector is 4-dimensional and the position vector is also 4-dimensional, concatenation yields 8 dimensions. The information indeed doesn't get mixed — but doubling the dimension means the parameter count and computation of every subsequent layer double too.

Addition is cleaner: just add the two vectors element-wise, keeping the dimension unchanged. The premise is that subsequent processing must be able to extract both the token information and the position information from the summed vector, because a linear transformation can learn to separate the two added signals.

The standard Transformer chose addition, mainly for efficiency: the dimension doesn't grow, and the computation doesn't balloon.

## 6. Summary

1. Why positional encoding is necessary: attention is order-insensitive, while order matters a great deal to meaning
2. Why not count up from zero: first, the values would overwhelm everything else; second, it is semantically unnecessary
3. The Transformer's approach: encode with sine and cosine functions of different frequencies
4. The advantages: uniqueness, and a better fit for how language works
5. How to merge: add the positional encoding to the token embedding at each position
