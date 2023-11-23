import sqlite3
import asyncio
import aiohttp
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request, abort, render_template, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

progress_stream = []

def get_db_connection():
    conn = sqlite3.connect('web_graph.db')
    conn.row_factory = sqlite3.Row
    return conn

def insert_node(url):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('SELECT id FROM nodes WHERE url = ?', (url,))
    node = c.fetchone()
    if node is None:
        c.execute('INSERT INTO nodes (url) VALUES (?)', (url,))
        conn.commit()
        node_id = c.lastrowid
    else:
        node_id = node['id']
    return node_id

def insert_edge(source_id, target_id):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('SELECT COUNT(*) FROM edges WHERE source = ? AND target = ?', (source_id, target_id))
    if c.fetchone()[0] == 0:
        c.execute('INSERT INTO edges (source, target) VALUES (?, ?)', (source_id, target_id))
        conn.commit()

def insert_original_search(url, depth):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('INSERT INTO original_searches (url, max_depth, is_original) VALUES (?, ?, ?)', (url, depth, True))
    conn.commit()
    search_id = c.lastrowid
    return search_id

async def fetch_links_async(url, visited, depth=1, max_depth=4):
    if depth > max_depth:
        return

    source_id = insert_node(url)

    # Only proceed with crawling if the URL hasn't been visited yet
    if url not in visited:
        visited.add(url)
        print(f"Currently fetching links from: {url}")

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
        }

        async with aiohttp.ClientSession(headers=headers) as session:
            try:
                async with session.get(url) as response:
                    response.raise_for_status()
                    html_content = await response.text()
                    soup = BeautifulSoup(html_content, 'html.parser')
                    tasks = []

                    for link in soup.find_all('a', href=True):
                        href = link['href']
                        if href.startswith('http'):
                            target_id = insert_node(href)
                            insert_edge(source_id, target_id)
                            # Avoid re-crawling if the URL is already visited
                            if href not in visited:
                                print(f"Planning to visit: {href}")
                                task = fetch_links_async(href, visited, depth + 1, max_depth)
                                tasks.append(task)

                    await asyncio.gather(*tasks)

            except (aiohttp.ClientError, aiohttp.ClientResponseError) as e:
                print(f"Request failed for {url}: {e}")
            except Exception as e:
                print(f"Error processing link {url}: {e}")

        if depth == 1:
            print(f"Finished going over {url}.")
    else:
        print(f"Skipping already visited {url}.")

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/test')
def test():
    return render_template('test.html')

@app.route('/api/search', methods=['GET', 'POST'])
async def search():
    if request.method == 'POST':
        data = request.json
        starting_url = data.get('starting_url')
        max_depth = data.get('max_depth', 4)
    else:
        starting_url = request.args.get('starting_url')
        max_depth = request.args.get('max_depth', 4)
    
    if not starting_url or not starting_url.startswith('http'):
        abort(400, description="Invalid starting URL provided.")
    
    try:
        max_depth = int(max_depth)
    except ValueError:
        abort(400, description="Invalid max depth provided.")

    original_search_id = insert_original_search(starting_url, max_depth)

    visited_urls = set()
    await fetch_links_async(starting_url, visited_urls, max_depth=max_depth)
    return jsonify({"message": "Crawl started for {}".format(starting_url), 'original_search_id': original_search_id})

@app.route('/api/nodes', methods=['GET'])
def get_nodes():
    conn = get_db_connection()
    nodes = conn.execute('SELECT * FROM nodes').fetchall()
    conn.close()
    return jsonify([dict(node) for node in nodes])

@app.route('/api/edges', methods=['GET'])
def get_edges():
    conn = get_db_connection()
    edges = conn.execute('SELECT * FROM edges').fetchall()
    conn.close()
    return jsonify([dict(edge) for edge in edges])

@app.route('/api/original_search_ids', methods=['GET'])
def get_original_search_ids():
    conn = get_db_connection()
    search_ids = conn.execute('SELECT * FROM original_searches').fetchall()
    conn.close()
    return jsonify([dict(search_id) for search_id in search_ids])

if __name__ == '__main__':
    app.run(host='0.0.0.0', port='5000', debug=True)
