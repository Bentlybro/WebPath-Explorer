# WebPath Explorer 🌐🔍

Welcome to *WebPath Explorer*, your gateway to uncovering the hidden connections of the web! 🕸️

🔍 **How It Works**: Upon receiving an initial URL, WebPath Explorer dives in, harvesting every link from the site. Each link is stored and tagged as connected to the starting site. The tool then systematically visits each of these new sites, continuing to collect and link further URLs, thereby revealing the intricate web of connections between sites.

⚙️ **Technology Stack**: The visual mapping is powered by D3.js, offering an interactive and dynamic graphical representation of web connections. The backend, built with Python Flask, handles the web exploration, mapping, and data retrieval, storing the results in a database for the frontend visualization.

⚠️ **Performance Notice**: Currently, with over 20-30,000 nodes (websites) and 60,000 edges (links between websites), the tool may experience lag. We're working on optimizing this for smoother experiences in future updates.

🖱️ **Interactive Exploration**: Left-click on a node to start a search from that point, or right-click on a node to visit its webpage. Discover and navigate the web in a more intuitive and engaging way!

💻 **Getting Started**: To begin, `cd` into `WebPath Explorer`, run `python map.py`, then visit `http://127.0.0.1:5000`. After adding a website URL, check the terminal to see the traversal across sites. Note: The greater the 'max depth', the longer it takes to gather links and display the map. Your patience is appreciated as we continue to improve this tool!

📹 **Visualizing the Web**: Check out the video below showcasing 30,000 nodes and 60,000 edges. Note: The video has been sped up initially for a better viewing experience as we work on resolving the lag issues. This visualization beautifully captures the complex structure and interconnectedness of the internet.

🤝 **Join the Effort**: Contributions and pull requests are greatly appreciated! They play a crucial role in enhancing the capabilities of WebPath Explorer. Whether it's code optimization, new features, or bug fixes, your input helps us grow. Let's build a better tool together!
---
[If You Like This Project Join My Discord Server](https://discord.gg/XbrtTTM2ZZ)

https://github.com/Bentlybro/WebPath-Explorer/assets/27962737/269156c8-6adf-4a58-901d-2e0b1a97a5b9

![image](https://github.com/Bentlybro/WebPath-Explorer/assets/27962737/d9463746-70eb-4a8a-81df-6deffdf3c3fb)

![image](https://github.com/Bentlybro/WebPath-Explorer/assets/27962737/c647ad83-b3d9-408d-918a-14c614997afb)
