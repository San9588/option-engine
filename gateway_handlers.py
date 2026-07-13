import sqlite3
import sys
from aiohttp import web
import orjson

def is_readonly_sql(sql: str) -> bool:
    """
    Orignal Safety Check: Sirf single SELECT ya WITH queries allowed hain.
    Baaki saari DML/DDL commands (INSERT, UPDATE, DROP, ALTER) block hongi.
    """
    if not sql:
        return False
    
    s = sql.strip().lower()
    
    # Multiple statements block karne ke liye (SQL injection protection)
    if ";" in s:
        return False
        
    # Sirf safe read-only queries ko aage jaane dena hai
    return s.startswith("select") or s.startswith("with")

async def handle_db_query(request):
    """
    ===========================================================================
    INTEGRATED SAFE GATEWAY QUERY HANDLER (Zero-Lock Shared Memory Engine)
    ===========================================================================

    KAISE KAAM KARTA HAI:
    1. Yeh handler 'engine.py' (Main Process) ke andar hi ek naye route (/query)
       par register hota hai, jisse alag se koi naya server port nahi kholna padta.
    2. RAM Optimization: 'sys.modules' ka use karke yeh handler directly main
       engine ke active global variables (`DB_CONN`, `DB_LOCK`, `DB_PATH`) ko
       access karta hai. Isse library sirf ek baar import hoti hai aur naya
       connection kholne ka overhead bachta hai.
    3. Thread Safety: Jab bhi koi read query aati hai, yeh main engine ke hi
       `DB_LOCK` thread-lock ka upyog karta hai. Jab engine database me naya data
       write kar raha hota hai, yeh tab tak wait karta hai aur write khatam hote
       hi bina kisi 'Database Locked' error ke safe read operation perform karta hai.
    4. Security Control: `is_readonly_sql` ke zariya check kiya jata hai ki query
       sirf SELECT ya WITH wali ho. Kisi bhi tarah ka injection ya semicolon (;)
       paye jaane par yeh request ko automatic block kar deta hai.
    """
    import sys
    main_module = sys.modules.get('__main__')
    
    db_conn = getattr(main_module, 'DB_CONN', None)
    db_lock = getattr(main_module, 'DB_LOCK', None)
    db_filename = getattr(main_module, 'DB_PATH', "unknown_db")
    
    # Engine ka main log function utha rahe hain, fallback me print use karenge
    engine_log = getattr(main_module, 'log', print)

    if not db_conn or not db_lock:
        engine_log("[GATEWAY ERROR] Database connection or lock not yet initialized by engine")
        return web.json_response({"error": "Database connection or lock not yet initialized by engine"}, status=503)
        
    try:
        body = await request.json(loads=orjson.loads)
        sql_query = (body.get("sql") or "").strip()
        params = body.get("params", [])

        if not is_readonly_sql(sql_query):
            engine_log(f"[GATEWAY BLOCK] Unauthorized query attempt: '{sql_query}'")
            return web.json_response({"error": "Security Block: Only single SELECT or WITH queries are allowed"}, status=403)

        # Query chalne ka log
        engine_log(f"[GATEWAY REQ] Executing SQL: '{sql_query}' | Params: {params}")

        with db_lock:
            cursor = db_conn.execute(sql_query, params)
            columns = [col[0] for col in cursor.description] if cursor.description else []
            rows = cursor.fetchmany(10001)

        truncated = len(rows) > 10000
        if truncated:
            rows = rows[:10000]

        # Query successfully khatam hone ka log
        engine_log(f"[GATEWAY SUCCESS] Returned {len(rows)} rows | Truncated: {truncated}")

        return web.Response(
            body=orjson.dumps({
                "db": db_filename,
                "count": len(rows),
                "truncated": truncated,
                "columns": columns,
                "rows": rows
            }),
            content_type="application/json"
        )
    except orjson.JSONDecodeError:
        engine_log("[GATEWAY ERROR] Invalid JSON format received")
        return web.json_response({"error": "Invalid JSON body format"}, status=400)
    except sqlite3.Error as e:
        engine_log(f"[GATEWAY SQL ERROR] {e}")
        return web.json_response({"error": f"Database execution error: {e}"}, status=400)
    except Exception as e:
        engine_log(f"[GATEWAY INTERNAL ERROR] {str(e)}")
        return web.json_response({"error": f"Internal server error: {str(e)}"}, status=500)
