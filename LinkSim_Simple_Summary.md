# LinkSim — How It Works (Simple Version)

LinkSim helps a factory answer the question: **"If we run our production line like this, what will happen?"** — without actually changing anything on the real factory floor. It's like a practice run using a computer model.

Here's the journey from start to finish:

## 1. Upload your factory data

You give LinkSim a file — an Excel sheet, a CSV, or a few files — that describes your factory:
- What stations/machines you have
- How many workers you have
- What order the product moves through the stations
- How many units you need to make

LinkSim reads this file and figures out what's what, even if the file isn't perfectly formatted (extra blank rows, slightly different column names, etc. don't break it). If some information is missing, it still works with what you gave it.

## 2. It gets saved

Once read, this information is saved so you can come back to it later, rename it, edit it, or re-download your original file if needed.

## 3. See it drawn out visually

LinkSim draws your factory as a flowchart — boxes connected by arrows, showing the path a product takes from station to station. If a station has 2 or 3 machines working side by side, it shows that as separate boxes automatically. You can also build or edit this flowchart yourself by clicking and adding boxes.

## 4. Run the simulation

This is the core of the tool. LinkSim runs a **virtual version of your factory** — it pretends to make each unit, one at a time, sending it through every station just like it would happen in real life:
- It respects work shifts and weekends (a station only works when it's supposed to).
- It accounts for workers being available or not.
- It simulates machines randomly breaking down and needing repair, just like real machines do.
- It simulates scheduled maintenance.
- It simulates some products needing rework (fixing mistakes).

You can also tell it to repeat the whole simulation multiple times (say, 5 times) to get more reliable, statistically sound results instead of relying on just one lucky or unlucky run.

## 5. Watch it happen live

While the simulation is running, you see a live progress bar and updates — you don't have to wait blindly for it to finish.

## 6. See the results

Once done, you get a dashboard showing:
- How many units got made
- How busy each station and each worker was (as a percentage)
- Which station is the **bottleneck** — the one slowing everything down
- How much rework happened
- How many breakdowns occurred
- A timeline (like a calendar view) of exactly when each job happened at each station

Stations are color-coded — green if healthy, yellow if under heavy load, red if it's a bottleneck — so problem areas jump out immediately.

## 7. Get smart suggestions

LinkSim also gives you plain-English recommendations, like "this station needs another worker" or "this machine's breakdown rate is hurting output — consider more frequent maintenance." 

**Important honesty note:** these suggestions come from built-in rules and formulas (if X is true, recommend Y) — not from an AI chatbot or anything like ChatGPT. They're smart and useful, but they're not "AI" in the trendy sense — worth knowing so nobody oversells this part.

## 8. Export a report

When you're happy with the results, you can export everything as a PDF to share with others. Right now this works by using your browser's built-in "Print to PDF" feature — it's simple and works well, but it's not a fancy custom-generated report file; it's essentially printing the screen.

---

## In one sentence

**Upload your factory's data → see it drawn as a flowchart → run a realistic virtual simulation of your production line (shifts, breakdowns, rework, and all) → get clear results, charts, and helpful suggestions → export it all as a PDF.**
