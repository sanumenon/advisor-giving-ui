# advisor-giving-ui
Giving Advisor - Version 2

Use Case :

Sl No	Use Case	Example (What the user does / sees)
1	Select User Profile (Dropdown)	User selects “Priya (user10)” from the dropdown; avatar 🌱 and name “Priya” appear in the header.
2	View Personalized Defaults	After selecting Priya, the system automatically prefers Education & Environment in Alberta without the user typing them.
3a	Allocate by Amount	User types: “Allocate $500” → system distributes $500 across relevant charities.
3b	Allocate by Cause	User types: “Allocate $300 for health and education” → only charities matching those causes are considered.
3c	Allocate by Region	User types: “Allocate $200 in Alberta” → charities located in Alberta are selected.
3d	Allocate to Explicit Charities	User types: “Allocate $500 to Community Foundation 51 and National Charity 52” → only those two charities are used.
4	Smart Allocation (Weighted)	User types: “Allocate $500” → Charity A gets $180, Charity B $140, Charity C $100 based on impact scores (not equal split).
5a	Minimum Amount Validation	User types: “Allocate $3” → system responds: “Minimum allocation amount is $5.”
5b	Exact Total Matching	User allocates $500 → allocation table totals exactly $500, no rounding mismatch.
5c	No Hallucinated Charities	User types: “Donate to Helping Hands International” → system replies: “No matching charities found in the dataset.”
6	View Allocation Table	System displays a table with columns: **Charity
7	View Portfolio Summary	System outputs: “Priya, this portfolio allocates $500 across charities in Alberta…”
8	Explain / Audit Allocation	User types: “Explain this allocation” → system shows donor counts, program ratio, trends used in scoring.
9	Change User & Reset Context	User switches from Sanu to Rahul → chat resets and defaults change to Environment in Alberta.
10	Guardrail: Reject Invalid Queries	User types: “What is your name?” → system replies: “I can help with donation allocations…”
11a	Follow User Default Causes	User says: “Allocate $400” → system automatically uses user’s default causes (e.g., Environment).
11b	Follow User Default Regions	User says: “Allocate $400” → system automatically restricts to user’s default region (e.g., Ontario).
12	Generate Deterministic Narrative	Same input run twice produces identical Portfolio Summary text, no randomness.
13	View Charity Details & Links	Each charity row includes a clickable link to my.charitableimpact.com/charity/ch_xxxxx.
14	Maintain Conversation Context	User says: “Increase it to $700” → system applies $700 to the previous charity selection.
